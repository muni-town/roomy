//! Matrix space hierarchy → Roomy's two levels.
//!
//! A Matrix space is a DAG: `m.space.child` state events, arbitrary depth, and a
//! room may hang under several parents. Roomy is two levels — a channel with
//! threads under it. The mapping is therefore lossy by construction, and this
//! module's job is to make the loss explicit and deterministic rather than to
//! hide it.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::ids::MatrixRoomId;
use crate::op::RoomyRoomKind;

/// One room discovered in a Matrix space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceNode {
    pub room_id: MatrixRoomId,
    /// `m.room.name`, when the room has one.
    pub name: Option<String>,
    /// Whether this node is itself an `m.space` (a nested space).
    pub is_space: bool,
    /// Rooms this node declares as children, in declaration order.
    pub children: Vec<MatrixRoomId>,
    /// The Matrix event that declared this node a child of its parent, used as
    /// the room's origin stamp.
    pub child_event_id: Option<String>,
}

impl SpaceNode {
    pub fn new(room_id: MatrixRoomId, name: Option<String>, is_space: bool) -> Self {
        Self {
            room_id,
            name,
            is_space,
            children: Vec::new(),
            child_event_id: None,
        }
    }
}

/// What the bridge decided to do with a discovered room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum HierarchyDecision {
    /// Depth 1: a channel directly under the bridged space.
    Channel { name: String },
    /// Depth 2: a thread under the channel at depth 1.
    Thread { name: String, parent: MatrixRoomId },
    /// Depth ≥ 3: flattened into the nearest depth-2 ancestor's thread, with a
    /// name that keeps the intervening path so a reader can tell.
    Flattened {
        name: String,
        parent: MatrixRoomId,
        depth: u32,
        warning: String,
    },
}

impl HierarchyDecision {
    pub fn roomy_kind(&self) -> RoomyRoomKind {
        match self {
            HierarchyDecision::Channel { .. } => RoomyRoomKind::Channel,
            HierarchyDecision::Thread { .. } | HierarchyDecision::Flattened { .. } => {
                RoomyRoomKind::Thread
            }
        }
    }

    /// The Roomy room name.
    pub fn name(&self) -> &str {
        match self {
            HierarchyDecision::Channel { name }
            | HierarchyDecision::Thread { name, .. }
            | HierarchyDecision::Flattened { name, .. } => name,
        }
    }

    /// The parent Matrix room for thread-shaped decisions.
    pub fn parent(&self) -> Option<&MatrixRoomId> {
        match self {
            HierarchyDecision::Channel { .. } => None,
            HierarchyDecision::Thread { parent, .. }
            | HierarchyDecision::Flattened { parent, .. } => Some(parent),
        }
    }

    /// The warning a flattened decision carries, when it has one.
    pub fn warning(&self) -> Option<&str> {
        match self {
            HierarchyDecision::Flattened { warning, .. } => Some(warning),
            _ => None,
        }
    }
}

/// A hierarchy that could not be bridged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HierarchyError {
    /// The `m.space.child` graph contains a cycle. Refused rather than
    /// half-bridged: a cycle has no canonical root, so any choice would be
    /// arbitrary and unstable across restarts.
    #[error("the Matrix space contains a cycle: {}", cycle.join(" -> "))]
    Cycle { cycle: Vec<String> },
    /// The space has no children at all.
    #[error("the Matrix space has no child rooms")]
    Empty,
}

/// The derived structure plan for one Matrix space.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hierarchy {
    /// Decisions in breadth-first declaration order.
    pub decisions: Vec<(MatrixRoomId, HierarchyDecision)>,
    /// Rooms reached under more than one parent, mapped to the parent chosen.
    /// They are bridged once, under the first canonical parent.
    pub multi_parent: BTreeMap<MatrixRoomId, MatrixRoomId>,
    /// True when any room needed flattening, so the caller can warn once.
    pub flattened_any: bool,
}

impl Hierarchy {
    pub fn decision(&self, room_id: &MatrixRoomId) -> Option<&HierarchyDecision> {
        self.decisions
            .iter()
            .find_map(|(id, decision)| (id == room_id).then_some(decision))
    }

    /// The bridged rooms, in the order they should be created (parents before
    /// their threads, so a thread's parent id already exists).
    pub fn ordered(&self) -> &[(MatrixRoomId, HierarchyDecision)] {
        &self.decisions
    }
}

/// Derive the Roomy structure for a Matrix space rooted at `root`.
///
/// `nodes` must contain an entry for the root and for every room reachable
/// from it. Rooms missing from the map are skipped rather than invented — a
/// child the homeserver did not describe is a state gap, not a room the bridge
/// should create blind.
pub fn derive(
    nodes: &BTreeMap<MatrixRoomId, SpaceNode>,
    root: &MatrixRoomId,
) -> Result<Hierarchy, HierarchyError> {
    if let Some(cycle) = find_cycle(nodes, root) {
        return Err(HierarchyError::Cycle {
            cycle: cycle.iter().map(|id| id.as_str().to_string()).collect(),
        });
    }

    let root_node = match nodes.get(root) {
        Some(node) if !node.children.is_empty() => node,
        _ => return Err(HierarchyError::Empty),
    };

    let mut hierarchy = Hierarchy::default();
    let mut seen: BTreeSet<MatrixRoomId> = BTreeSet::new();
    let mut queue: VecDeque<(MatrixRoomId, u32, Option<MatrixRoomId>, String)> = VecDeque::new();

    for child in &root_node.children {
        queue.push_back((child.clone(), 1, None, String::new()));
    }

    while let Some((room_id, depth, channel_ancestor, path)) = queue.pop_front() {
        let node = match nodes.get(&room_id) {
            Some(node) => node,
            None => continue,
        };

        // A room reached twice is bridged once, under its first canonical
        // parent — breadth-first order makes "first" mean "furthest up the
        // hierarchy", which is the one a reader would expect. The map records
        // the parent that won, because that is the fact an operator needs:
        // where the room actually lives on the Roomy side.
        if !seen.insert(room_id.clone()) {
            if let Some(parent) = hierarchy
                .decision(&room_id)
                .and_then(|decision| decision.parent().cloned())
            {
                hierarchy.multi_parent.insert(room_id.clone(), parent);
            }
            continue;
        }

        let display_name = node
            .name
            .clone()
            .unwrap_or_else(|| room_id.as_str().to_string());
        let name = if path.is_empty() {
            display_name.clone()
        } else {
            format!("{path} / {display_name}")
        };

        let decision = match depth {
            1 => HierarchyDecision::Channel { name },
            2 => HierarchyDecision::Thread {
                name,
                parent: channel_ancestor.clone().unwrap_or_else(|| root.clone()),
            },
            deep => {
                hierarchy.flattened_any = true;
                let parent = channel_ancestor.clone().unwrap_or_else(|| root.clone());
                let warning = format!(
                    "{room_id} is {deep} levels deep in the Matrix space; Roomy has two, \
                     so it is bridged as a thread under {parent} with its path in the name"
                );
                HierarchyDecision::Flattened {
                    name,
                    parent,
                    depth: deep,
                    warning,
                }
            }
        };

        hierarchy.decisions.push((room_id.clone(), decision));

        if !node.children.is_empty() {
            // The ancestor a thread attaches to: at depth 1 the node is itself
            // the channel; deeper, the channel stays the one already found.
            let next_ancestor = if depth == 1 {
                Some(room_id.clone())
            } else {
                channel_ancestor.clone().or_else(|| Some(room_id.clone()))
            };
            let next_path = if depth == 1 {
                String::new()
            } else if path.is_empty() {
                display_name
            } else {
                format!("{path} / {display_name}")
            };
            for child in &node.children {
                queue.push_back((
                    child.clone(),
                    depth + 1,
                    next_ancestor.clone(),
                    next_path.clone(),
                ));
            }
        }
    }

    Ok(hierarchy)
}

/// Find a cycle reachable from `root`, returning the cycle path if one exists.
fn find_cycle(
    nodes: &BTreeMap<MatrixRoomId, SpaceNode>,
    root: &MatrixRoomId,
) -> Option<Vec<MatrixRoomId>> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Unvisited,
        OnStack,
        Done,
    }

    fn walk(
        nodes: &BTreeMap<MatrixRoomId, SpaceNode>,
        node: &MatrixRoomId,
        marks: &mut BTreeMap<MatrixRoomId, Mark>,
        stack: &mut Vec<MatrixRoomId>,
    ) -> Option<Vec<MatrixRoomId>> {
        match marks.get(node).copied().unwrap_or(Mark::Unvisited) {
            Mark::Done => return None,
            Mark::OnStack => {
                // Reconstruct the cycle from where it started on the stack.
                let start = stack.iter().position(|id| id == node)?;
                let mut cycle = stack[start..].to_vec();
                cycle.push(node.clone());
                return Some(cycle);
            }
            Mark::Unvisited => {}
        }

        marks.insert(node.clone(), Mark::OnStack);
        stack.push(node.clone());

        if let Some(entry) = nodes.get(node) {
            for child in &entry.children {
                if let Some(cycle) = walk(nodes, child, marks, stack) {
                    return Some(cycle);
                }
            }
        }

        stack.pop();
        marks.insert(node.clone(), Mark::Done);
        None
    }

    let mut marks = BTreeMap::new();
    let mut stack = Vec::new();
    walk(nodes, root, &mut marks, &mut stack)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(id: &str, name: &str, children: &[&str]) -> (MatrixRoomId, SpaceNode) {
        let room_id = MatrixRoomId::parse(id).unwrap();
        let mut node = SpaceNode::new(room_id.clone(), Some(name.to_string()), true);
        node.children = children
            .iter()
            .map(|child| MatrixRoomId::parse(*child).unwrap())
            .collect();
        (room_id, node)
    }

    fn graph(entries: Vec<(MatrixRoomId, SpaceNode)>) -> BTreeMap<MatrixRoomId, SpaceNode> {
        entries.into_iter().collect()
    }

    #[test]
    fn depth_one_becomes_a_channel_and_depth_two_a_thread() {
        let nodes = graph(vec![
            room(
                "!space:example.org",
                "Engineering",
                &["!general:example.org", "!design:example.org"],
            ),
            room(
                "!general:example.org",
                "General",
                &["!frontend:example.org"],
            ),
            room("!design:example.org", "Design", &[]),
            room("!frontend:example.org", "Frontend", &[]),
        ]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        let hierarchy = derive(&nodes, &root).unwrap();

        let general = MatrixRoomId::parse("!general:example.org").unwrap();
        assert_eq!(
            hierarchy.decision(&general),
            Some(&HierarchyDecision::Channel {
                name: "General".into()
            })
        );

        let frontend = MatrixRoomId::parse("!frontend:example.org").unwrap();
        assert_eq!(
            hierarchy.decision(&frontend),
            Some(&HierarchyDecision::Thread {
                name: "Frontend".into(),
                parent: general,
            })
        );
    }

    #[test]
    fn depth_three_is_flattened_with_its_path_in_the_name() {
        let nodes = graph(vec![
            room(
                "!space:example.org",
                "Engineering",
                &["!general:example.org"],
            ),
            room("!general:example.org", "General", &["!team:example.org"]),
            room("!team:example.org", "Team", &["!deep:example.org"]),
            room("!deep:example.org", "Deep", &[]),
        ]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        let hierarchy = derive(&nodes, &root).unwrap();

        let deep = MatrixRoomId::parse("!deep:example.org").unwrap();
        let decision = hierarchy.decision(&deep).unwrap();
        match decision {
            HierarchyDecision::Flattened {
                name,
                parent,
                depth,
                ..
            } => {
                assert_eq!(*depth, 3);
                assert_eq!(name, "Team / Deep");
                assert_eq!(parent.as_str(), "!general:example.org");
            }
            other => panic!("expected a flattened decision, got {other:?}"),
        }
        assert!(hierarchy.flattened_any);
    }

    #[test]
    fn a_room_under_two_parents_is_bridged_once() {
        let nodes = graph(vec![
            room(
                "!space:example.org",
                "Engineering",
                &["!a:example.org", "!b:example.org"],
            ),
            room("!a:example.org", "A", &["!shared:example.org"]),
            room("!b:example.org", "B", &["!shared:example.org"]),
            room("!shared:example.org", "Shared", &[]),
        ]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        let hierarchy = derive(&nodes, &root).unwrap();

        let shared = MatrixRoomId::parse("!shared:example.org").unwrap();
        let occurrences = hierarchy
            .ordered()
            .iter()
            .filter(|(id, _)| id == &shared)
            .count();
        assert_eq!(occurrences, 1);
        assert_eq!(
            hierarchy.multi_parent.get(&shared).map(|p| p.as_str()),
            Some("!a:example.org")
        );
    }

    #[test]
    fn a_cycle_is_refused_and_named() {
        let nodes = graph(vec![
            room("!space:example.org", "Space", &["!a:example.org"]),
            room("!a:example.org", "A", &["!b:example.org"]),
            room("!b:example.org", "B", &["!a:example.org"]),
        ]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        let error = derive(&nodes, &root).unwrap_err();
        match error {
            HierarchyError::Cycle { cycle } => {
                assert!(cycle.contains(&"!a:example.org".to_string()));
                assert!(cycle.contains(&"!b:example.org".to_string()));
            }
            other => panic!("expected a cycle error, got {other:?}"),
        }
    }

    #[test]
    fn a_space_without_children_is_refused() {
        let nodes = graph(vec![room("!space:example.org", "Space", &[])]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        assert_eq!(derive(&nodes, &root), Err(HierarchyError::Empty));
    }

    #[test]
    fn children_are_created_before_the_threads_that_attach_to_them() {
        let nodes = graph(vec![
            room("!space:example.org", "Space", &["!channel:example.org"]),
            room("!channel:example.org", "Channel", &["!thread:example.org"]),
            room("!thread:example.org", "Thread", &[]),
        ]);
        let root = MatrixRoomId::parse("!space:example.org").unwrap();
        let hierarchy = derive(&nodes, &root).unwrap();
        let order: Vec<_> = hierarchy
            .ordered()
            .iter()
            .map(|(id, _)| id.as_str().to_string())
            .collect();
        assert_eq!(order, vec!["!channel:example.org", "!thread:example.org"]);
    }
}
