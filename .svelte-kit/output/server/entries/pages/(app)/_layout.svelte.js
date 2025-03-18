import { A as once, w as push, B as copy_payload, C as assign_payload, E as bind_props, y as pop, F as spread_props, G as spread_attributes, I as ensure_array_like, J as fallback, K as attr, M as attr_style, N as stringify, z as escape_html, O as attr_class, P as store_get, Q as unsubscribe_stores, R as head } from "../../../chunks/index.js";
import { g as goto } from "../../../chunks/client.js";
import { g } from "../../../chunks/global.svelte.js";
import { u as user } from "../../../chunks/user.svelte.js";
import "@automerge/automerge";
import "base32-encode";
import "base32-decode";
import { o as onDestroy, I as Icon } from "../../../chunks/Icon.js";
import { D as Dialog_1 } from "../../../chunks/Dialog.js";
import { H as Hidden_input, P as Popper_layer_force_mount, a as Popper_layer, F as Floating_layer, b as Floating_layer_anchor, g as getRandomId, c as getNumber, d as getRandomColor, D as DEFAULTS, u as useToasterStore, t as toast, s as startPause, e as endPause, f as update, p as prefersReducedMotion, A as Avatar, h as Avatar_image, i as Avatar_fallback, j as AvatarImage } from "../../../chunks/Toaster.svelte_svelte_type_style_lang.js";
import { Agent } from "@atproto/api";
import * as base64 from "js-base64";
import { r as resolveDid, b as box, n as noop, a as afterTick, C as Context, u as useRefById, A as ARROW_UP, c as ARROW_DOWN, E as ENTER, S as SPACE, T as TAB, P as PAGE_DOWN, d as PAGE_UP, H as HOME, e as END, g as getAriaExpanded, f as getDataOpenClosed, h as getDataDisabled, i as getDisabled, j as getRequired, k as isIOS, l as useId, m as mergeProps, o as Portal, B as Button } from "../../../chunks/button.js";
import { o as on } from "../../../chunks/events.js";
import { T as Toggle_group, a as Toggle_group_item } from "../../../chunks/toggle-group-item.js";
class RoomyPdsStorageAdapter {
  agent;
  /** Additional DIDs that records will be _downloaded from_. Obviously we cannot delete or change
   * the records, but they can contribute to our synchronization. */
  additionalDids;
  additionalAgents = Promise.resolve({});
  static async buildKey(key) {
    if (key.some((x) => x.includes("\0")))
      throw "Cannot encode paths containing null bytes";
    const data = new Uint8Array(new TextEncoder().encode(key.join("\0")));
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(data))
    );
    return base64.fromUint8Array(hash, true);
  }
  constructor(agent, ...additionalDids) {
    this.agent = agent;
    this.additionalDids = additionalDids;
    this.additionalAgents = (async () => {
      const agents = {};
      for (const did of additionalDids) {
        const didDoc = await resolveDid(did);
        if (!didDoc) throw `Could not resolve DID doc for ${did}`;
        const pdsService = (didDoc.service || []).find(
          (x) => x.id === "#atproto_pds"
        );
        if (!pdsService || typeof pdsService.serviceEndpoint !== "string")
          throw `Could not resolve PDS service for ${did}`;
        agents[did] = new Agent(pdsService.serviceEndpoint);
      }
      return agents;
    })();
  }
  static async *listRecords(agent, did, prefix) {
    let cursor;
    do {
      const resp = await agent.com.atproto.repo.listRecords({
        collection: "chat.roomy.v1.store",
        repo: did,
        cursor,
        limit: 100
      });
      if (!resp.success) throw `Error listing records from PDS: ${resp}`;
      cursor = resp.data.cursor;
      for (const record of resp.data.records) {
        const rdata = record.value;
        let prefixMatches = true;
        for (let i = 0; i < prefix.length; i++) {
          if (prefix[i] != rdata.key[i]) {
            prefixMatches = false;
            break;
          }
        }
        if (prefixMatches) {
          yield {
            blobCid: rdata.data.ref.toString(),
            key: rdata.key,
            did
          };
        }
      }
    } while (cursor);
  }
  async load(key) {
    const resp = await this.agent.com.atproto.repo.getRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key)
    });
    if (!resp.success) return void 0;
    const blob = await this.agent.com.atproto.sync.getBlob({
      cid: resp.data.ref.toString(),
      did: this.agent.assertDid
    });
    if (!blob.success) return void 0;
    return blob.data;
  }
  async save(key, data) {
    const resp = await this.agent.uploadBlob(data);
    if (!resp.success)
      throw `Error uploading blob to PDS ( \`${key}\` ): ${resp}`;
    const putResp = await this.agent.com.atproto.repo.putRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key),
      record: {
        key,
        data: resp.data.blob
      }
    });
    if (!putResp.success) throw `Error putting store record to PDS: ${resp}`;
  }
  async remove(key) {
    const resp = await this.agent.com.atproto.repo.deleteRecord({
      collection: "chat.roomy.v1.store",
      repo: this.agent.assertDid,
      rkey: await RoomyPdsStorageAdapter.buildKey(key)
    });
    if (!resp.success)
      throw `Error deleting record from PDS ( \`${key}\` ): ${resp}`;
  }
  async loadRange(key) {
    const records = [];
    for (const did of [this.agent.assertDid, ...this.additionalDids]) {
      const a = did == this.agent.assertDid ? this.agent : (await this.additionalAgents)[did];
      for await (const record of RoomyPdsStorageAdapter.listRecords(
        a,
        did,
        key
      )) {
        const resp = await a.com.atproto.sync.getBlob({
          cid: record.blobCid,
          did
        });
        if (!resp.success) console.warn("Error downloading blob", resp);
        records.push({
          key: record.key,
          data: resp.success ? new Uint8Array(resp.data.buffer) : void 0
        });
      }
    }
    return records;
  }
  async removeRange(key) {
    for await (const record of RoomyPdsStorageAdapter.listRecords(
      this.agent,
      this.agent.assertDid,
      key
    )) {
      if (record.did == this.agent.assertDid) {
        const resp = await this.agent.com.atproto.repo.deleteRecord({
          repo: this.agent.assertDid,
          collection: "chat.roomy.v1.store",
          rkey: await RoomyPdsStorageAdapter.buildKey(record.key)
        });
        if (!resp.success) console.warn("Error deleting record", resp.data);
      }
    }
  }
}
class Previous {
  #previous = void 0;
  #curr;
  constructor(getter) {
  }
  get current() {
    return this.#previous;
  }
}
function next(array, index, loop = true) {
  if (array.length === 0 || index < 0 || index >= array.length) {
    return void 0;
  }
  if (array.length === 1 && index === 0) {
    return array[0];
  }
  if (index === array.length - 1) {
    return loop ? array[0] : void 0;
  }
  return array[index + 1];
}
function prev(array, index, loop = true) {
  if (array.length === 0 || index < 0 || index >= array.length) {
    return void 0;
  }
  if (array.length === 1 && index === 0) {
    return array[0];
  }
  if (index === 0) {
    return loop ? array[array.length - 1] : void 0;
  }
  return array[index - 1];
}
function forward(array, index, increment, loop = true) {
  if (array.length === 0 || index < 0 || index >= array.length) {
    return void 0;
  }
  let targetIndex = index + increment;
  if (loop) {
    targetIndex = (targetIndex % array.length + array.length) % array.length;
  } else {
    targetIndex = Math.max(0, Math.min(targetIndex, array.length - 1));
  }
  return array[targetIndex];
}
function backward(array, index, decrement, loop = true) {
  if (array.length === 0 || index < 0 || index >= array.length) {
    return void 0;
  }
  let targetIndex = index - decrement;
  if (loop) {
    targetIndex = (targetIndex % array.length + array.length) % array.length;
  } else {
    targetIndex = Math.max(0, Math.min(targetIndex, array.length - 1));
  }
  return array[targetIndex];
}
function getNextMatch(values, search, currentMatch) {
  const isRepeated = search.length > 1 && Array.from(search).every((char) => char === search[0]);
  const normalizedSearch = isRepeated ? search[0] : search;
  const currentMatchIndex = currentMatch ? values.indexOf(currentMatch) : -1;
  let wrappedValues = wrapArray(values, Math.max(currentMatchIndex, 0));
  const excludeCurrentMatch = normalizedSearch.length === 1;
  if (excludeCurrentMatch)
    wrappedValues = wrappedValues.filter((v) => v !== currentMatch);
  const nextMatch = wrappedValues.find((value) => value?.toLowerCase().startsWith(normalizedSearch.toLowerCase()));
  return nextMatch !== currentMatch ? nextMatch : void 0;
}
function wrapArray(array, startIndex) {
  return array.map((_, index) => array[(startIndex + index) % array.length]);
}
function boxAutoReset(defaultValue, afterMs = 1e4, onChange = noop) {
  let timeout = null;
  let value = defaultValue;
  function resetAfter() {
    return window.setTimeout(
      () => {
        value = defaultValue;
        onChange(defaultValue);
      },
      afterMs
    );
  }
  return box.with(() => value, (v) => {
    value = v;
    onChange(v);
    if (timeout) clearTimeout(timeout);
    timeout = resetAfter();
  });
}
function useDOMTypeahead(opts) {
  const search = boxAutoReset("", 1e3);
  const onMatch = opts?.onMatch;
  const getCurrentItem = opts?.getCurrentItem;
  function handleTypeaheadSearch(key, candidates) {
    if (!candidates.length) return;
    search.current = search.current + key;
    const currentItem = getCurrentItem();
    const currentMatch = candidates.find((item) => item === currentItem)?.textContent?.trim() ?? "";
    const values = candidates.map((item) => item.textContent?.trim() ?? "");
    const nextMatch = getNextMatch(values, search.current, currentMatch);
    const newItem = candidates.find((item) => item.textContent?.trim() === nextMatch);
    if (newItem) {
      onMatch(newItem);
    }
    return newItem;
  }
  function resetTypeahead() {
    search.current = "";
  }
  return {
    search,
    handleTypeaheadSearch,
    resetTypeahead
  };
}
function useDataTypeahead(opts) {
  const search = boxAutoReset("", 1e3);
  function handleTypeaheadSearch(key, candidateValues) {
    if (!opts.enabled) return;
    if (!candidateValues.length) return;
    search.current = search.current + key;
    const currentItem = opts.getCurrentItem();
    const currentMatch = candidateValues.find((item) => item === currentItem) ?? "";
    const values = candidateValues.map((item) => item ?? "");
    const nextMatch = getNextMatch(values, search.current, currentMatch);
    const newItem = candidateValues.find((item) => item === nextMatch);
    if (newItem) {
      opts.onMatch(newItem);
    }
    return newItem;
  }
  function resetTypeahead() {
    search.current = "";
  }
  return {
    search,
    handleTypeaheadSearch,
    resetTypeahead
  };
}
const FIRST_KEYS = [ARROW_DOWN, PAGE_UP, HOME];
const LAST_KEYS = [ARROW_UP, PAGE_DOWN, END];
const FIRST_LAST_KEYS = [...FIRST_KEYS, ...LAST_KEYS];
class SelectBaseRootState {
  opts;
  touchedInput = false;
  inputValue = "";
  inputNode = null;
  contentNode = null;
  triggerNode = null;
  valueId = "";
  highlightedNode = null;
  #highlightedValue = once(() => {
    if (!this.highlightedNode) return null;
    return this.highlightedNode.getAttribute("data-value");
  });
  get highlightedValue() {
    return this.#highlightedValue();
  }
  #highlightedId = once(() => {
    if (!this.highlightedNode) return void 0;
    return this.highlightedNode.id;
  });
  get highlightedId() {
    return this.#highlightedId();
  }
  #highlightedLabel = once(() => {
    if (!this.highlightedNode) return null;
    return this.highlightedNode.getAttribute("data-label");
  });
  get highlightedLabel() {
    return this.#highlightedLabel();
  }
  isUsingKeyboard = false;
  isCombobox = false;
  bitsAttrs;
  constructor(opts) {
    this.opts = opts;
    this.isCombobox = opts.isCombobox;
    this.bitsAttrs = getSelectBitsAttrs(this);
  }
  setHighlightedNode(node, initial = false) {
    this.highlightedNode = node;
    if (node && (this.isUsingKeyboard || initial)) {
      node.scrollIntoView({ block: "nearest" });
    }
  }
  getCandidateNodes() {
    const node = this.contentNode;
    if (!node) return [];
    const nodes = Array.from(node.querySelectorAll(`[${this.bitsAttrs.item}]:not([data-disabled])`));
    return nodes;
  }
  setHighlightedToFirstCandidate() {
    this.setHighlightedNode(null);
    const candidateNodes = this.getCandidateNodes();
    if (!candidateNodes.length) return;
    this.setHighlightedNode(candidateNodes[0]);
  }
  getNodeByValue(value) {
    const candidateNodes = this.getCandidateNodes();
    return candidateNodes.find((node) => node.dataset.value === value) ?? null;
  }
  setOpen(open) {
    this.opts.open.current = open;
  }
  toggleOpen() {
    this.opts.open.current = !this.opts.open.current;
  }
  handleOpen() {
    this.setOpen(true);
  }
  handleClose() {
    this.setHighlightedNode(null);
    this.setOpen(false);
  }
  toggleMenu() {
    this.toggleOpen();
  }
}
class SelectSingleRootState extends SelectBaseRootState {
  opts;
  isMulti = false;
  #hasValue = once(() => this.opts.value.current !== "");
  get hasValue() {
    return this.#hasValue();
  }
  #currentLabel = once(() => {
    if (!this.opts.items.current.length) return "";
    const match = this.opts.items.current.find((item) => item.value === this.opts.value.current)?.label;
    return match ?? "";
  });
  get currentLabel() {
    return this.#currentLabel();
  }
  #candidateLabels = once(() => {
    if (!this.opts.items.current.length) return [];
    const filteredItems = this.opts.items.current.filter((item) => !item.disabled);
    return filteredItems.map((item) => item.label);
  });
  get candidateLabels() {
    return this.#candidateLabels();
  }
  #dataTypeaheadEnabled = once(() => {
    if (this.isMulti) return false;
    if (this.opts.items.current.length === 0) return false;
    return true;
  });
  get dataTypeaheadEnabled() {
    return this.#dataTypeaheadEnabled();
  }
  constructor(opts) {
    super(opts);
    this.opts = opts;
  }
  includesItem(itemValue) {
    return this.opts.value.current === itemValue;
  }
  toggleItem(itemValue, itemLabel = itemValue) {
    this.opts.value.current = this.includesItem(itemValue) ? "" : itemValue;
    this.inputValue = itemLabel;
  }
  setInitialHighlightedNode() {
    afterTick(() => {
      if (this.highlightedNode && document.contains(this.highlightedNode)) return;
      if (this.opts.value.current !== "") {
        const node = this.getNodeByValue(this.opts.value.current);
        if (node) {
          this.setHighlightedNode(node, true);
          return;
        }
      }
      const firstCandidate = this.getCandidateNodes()[0];
      if (!firstCandidate) return;
      this.setHighlightedNode(firstCandidate, true);
    });
  }
}
class SelectMultipleRootState extends SelectBaseRootState {
  opts;
  isMulti = true;
  #hasValue = once(() => this.opts.value.current.length > 0);
  get hasValue() {
    return this.#hasValue();
  }
  constructor(opts) {
    super(opts);
    this.opts = opts;
  }
  includesItem(itemValue) {
    return this.opts.value.current.includes(itemValue);
  }
  toggleItem(itemValue, itemLabel = itemValue) {
    if (this.includesItem(itemValue)) {
      this.opts.value.current = this.opts.value.current.filter((v) => v !== itemValue);
    } else {
      this.opts.value.current = [...this.opts.value.current, itemValue];
    }
    this.inputValue = itemLabel;
  }
  setInitialHighlightedNode() {
    afterTick(() => {
      if (this.highlightedNode && document.contains(this.highlightedNode)) return;
      if (this.opts.value.current.length && this.opts.value.current[0] !== "") {
        const node = this.getNodeByValue(this.opts.value.current[0]);
        if (node) {
          this.setHighlightedNode(node, true);
          return;
        }
      }
      const firstCandidate = this.getCandidateNodes()[0];
      if (!firstCandidate) return;
      this.setHighlightedNode(firstCandidate, true);
    });
  }
}
class SelectTriggerState {
  opts;
  root;
  #domTypeahead;
  #dataTypeahead;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.root.triggerNode = node;
      }
    });
    this.#domTypeahead = useDOMTypeahead({
      getCurrentItem: () => this.root.highlightedNode,
      onMatch: (node) => {
        this.root.setHighlightedNode(node);
      }
    });
    this.#dataTypeahead = useDataTypeahead({
      getCurrentItem: () => {
        if (this.root.isMulti) return "";
        return this.root.currentLabel;
      },
      onMatch: (label) => {
        if (this.root.isMulti) return;
        if (!this.root.opts.items.current) return;
        const matchedItem = this.root.opts.items.current.find((item) => item.label === label);
        if (!matchedItem) return;
        this.root.opts.value.current = matchedItem.value;
      },
      enabled: !this.root.isMulti && this.root.dataTypeaheadEnabled
    });
    this.onkeydown = this.onkeydown.bind(this);
    this.onpointerdown = this.onpointerdown.bind(this);
    this.onpointerup = this.onpointerup.bind(this);
    this.onclick = this.onclick.bind(this);
  }
  #handleOpen() {
    this.root.opts.open.current = true;
    this.#dataTypeahead.resetTypeahead();
    this.#domTypeahead.resetTypeahead();
  }
  #handlePointerOpen(_) {
    this.#handleOpen();
  }
  onkeydown(e) {
    this.root.isUsingKeyboard = true;
    if (e.key === ARROW_UP || e.key === ARROW_DOWN) e.preventDefault();
    if (!this.root.opts.open.current) {
      if (e.key === ENTER || e.key === SPACE || e.key === ARROW_DOWN || e.key === ARROW_UP) {
        e.preventDefault();
        this.root.handleOpen();
      } else if (!this.root.isMulti && this.root.dataTypeaheadEnabled) {
        this.#dataTypeahead.handleTypeaheadSearch(e.key, this.root.candidateLabels);
        return;
      }
      if (this.root.hasValue) return;
      const candidateNodes2 = this.root.getCandidateNodes();
      if (!candidateNodes2.length) return;
      if (e.key === ARROW_DOWN) {
        const firstCandidate = candidateNodes2[0];
        this.root.setHighlightedNode(firstCandidate);
      } else if (e.key === ARROW_UP) {
        const lastCandidate = candidateNodes2[candidateNodes2.length - 1];
        this.root.setHighlightedNode(lastCandidate);
      }
      return;
    }
    if (e.key === TAB) {
      this.root.handleClose();
      return;
    }
    if ((e.key === ENTER || e.key === SPACE) && !e.isComposing) {
      e.preventDefault();
      const isCurrentSelectedValue = this.root.highlightedValue === this.root.opts.value.current;
      if (!this.root.opts.allowDeselect.current && isCurrentSelectedValue && !this.root.isMulti) {
        this.root.handleClose();
        return;
      }
      if (this.root.highlightedValue !== null) {
        this.root.toggleItem(this.root.highlightedValue, this.root.highlightedLabel ?? void 0);
      }
      if (!this.root.isMulti && !isCurrentSelectedValue) {
        this.root.handleClose();
        return;
      }
    }
    if (e.key === ARROW_UP && e.altKey) {
      this.root.handleClose();
    }
    if (FIRST_LAST_KEYS.includes(e.key)) {
      e.preventDefault();
      const candidateNodes2 = this.root.getCandidateNodes();
      const currHighlightedNode = this.root.highlightedNode;
      const currIndex = currHighlightedNode ? candidateNodes2.indexOf(currHighlightedNode) : -1;
      const loop = this.root.opts.loop.current;
      let nextItem;
      if (e.key === ARROW_DOWN) {
        nextItem = next(candidateNodes2, currIndex, loop);
      } else if (e.key === ARROW_UP) {
        nextItem = prev(candidateNodes2, currIndex, loop);
      } else if (e.key === PAGE_DOWN) {
        nextItem = forward(candidateNodes2, currIndex, 10, loop);
      } else if (e.key === PAGE_UP) {
        nextItem = backward(candidateNodes2, currIndex, 10, loop);
      } else if (e.key === HOME) {
        nextItem = candidateNodes2[0];
      } else if (e.key === END) {
        nextItem = candidateNodes2[candidateNodes2.length - 1];
      }
      if (!nextItem) return;
      this.root.setHighlightedNode(nextItem);
      return;
    }
    const isModifierKey = e.ctrlKey || e.altKey || e.metaKey;
    const isCharacterKey = e.key.length === 1;
    if (e.code === "Space") return;
    const candidateNodes = this.root.getCandidateNodes();
    if (e.key === TAB) return;
    if (!isModifierKey && isCharacterKey) {
      this.#domTypeahead.handleTypeaheadSearch(e.key, candidateNodes);
      return;
    }
    if (!this.root.highlightedNode) {
      this.root.setHighlightedToFirstCandidate();
    }
  }
  onclick(e) {
    const currTarget = e.currentTarget;
    currTarget.focus();
  }
  onpointerdown(e) {
    if (this.root.opts.disabled.current) return;
    if (e.pointerType === "touch") return e.preventDefault();
    const target = e.target;
    if (target?.hasPointerCapture(e.pointerId)) {
      target?.releasePointerCapture(e.pointerId);
    }
    if (e.button === 0 && e.ctrlKey === false) {
      if (this.root.opts.open.current === false) {
        this.#handlePointerOpen(e);
      } else {
        this.root.handleClose();
      }
    }
  }
  onpointerup(e) {
    e.preventDefault();
    if (e.pointerType === "touch") {
      if (this.root.opts.open.current === false) {
        this.#handlePointerOpen(e);
      } else {
        this.root.handleClose();
      }
    }
  }
  #props = once(() => ({
    id: this.opts.id.current,
    disabled: this.root.opts.disabled.current ? true : void 0,
    "aria-haspopup": "listbox",
    "aria-expanded": getAriaExpanded(this.root.opts.open.current),
    "aria-activedescendant": this.root.highlightedId,
    "data-state": getDataOpenClosed(this.root.opts.open.current),
    "data-disabled": getDataDisabled(this.root.opts.disabled.current),
    "data-placeholder": this.root.hasValue ? void 0 : "",
    [this.root.bitsAttrs.trigger]: "",
    onpointerdown: this.onpointerdown,
    onkeydown: this.onkeydown,
    onclick: this.onclick,
    onpointerup: this.onpointerup
  }));
  get props() {
    return this.#props();
  }
}
class SelectContentState {
  opts;
  root;
  viewportNode = null;
  isPositioned = false;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.root.contentNode = node;
      },
      deps: () => this.root.opts.open.current
    });
    this.onpointermove = this.onpointermove.bind(this);
  }
  onpointermove(_) {
    this.root.isUsingKeyboard = false;
  }
  #styles = once(() => {
    const prefix = this.root.isCombobox ? "--bits-combobox" : "--bits-select";
    return {
      [`${prefix}-content-transform-origin`]: "var(--bits-floating-transform-origin)",
      [`${prefix}-content-available-width`]: "var(--bits-floating-available-width)",
      [`${prefix}-content-available-height`]: "var(--bits-floating-available-height)",
      [`${prefix}-anchor-width`]: " var(--bits-floating-anchor-width)",
      [`${prefix}-anchor-height`]: "var(--bits-floating-anchor-height)"
    };
  });
  onInteractOutside = (e) => {
    if (e.target === this.root.triggerNode || e.target === this.root.inputNode) {
      e.preventDefault();
      return;
    }
    this.opts.onInteractOutside.current(e);
    if (e.defaultPrevented) return;
    this.root.handleClose();
  };
  onEscapeKeydown = (e) => {
    this.opts.onEscapeKeydown.current(e);
    if (e.defaultPrevented) return;
    this.root.handleClose();
  };
  onOpenAutoFocus = (e) => {
    e.preventDefault();
  };
  onCloseAutoFocus = (e) => {
    e.preventDefault();
  };
  #snippetProps = once(() => ({ open: this.root.opts.open.current }));
  get snippetProps() {
    return this.#snippetProps();
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "listbox",
    "aria-multiselectable": this.root.isMulti ? "true" : void 0,
    "data-state": getDataOpenClosed(this.root.opts.open.current),
    [this.root.bitsAttrs.content]: "",
    style: {
      display: "flex",
      flexDirection: "column",
      outline: "none",
      boxSizing: "border-box",
      pointerEvents: "auto",
      ...this.#styles()
    },
    onpointermove: this.onpointermove
  }));
  get props() {
    return this.#props();
  }
  popperProps = {
    onInteractOutside: this.onInteractOutside,
    onEscapeKeydown: this.onEscapeKeydown,
    onOpenAutoFocus: this.onOpenAutoFocus,
    onCloseAutoFocus: this.onCloseAutoFocus,
    trapFocus: false,
    loop: false,
    onPlaced: () => {
      this.isPositioned = true;
    }
  };
}
class SelectItemState {
  opts;
  root;
  #isSelected = once(() => this.root.includesItem(this.opts.value.current));
  get isSelected() {
    return this.#isSelected();
  }
  #isHighlighted = once(() => this.root.highlightedValue === this.opts.value.current);
  get isHighlighted() {
    return this.#isHighlighted();
  }
  prevHighlighted = new Previous(() => this.isHighlighted);
  mounted = false;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById({ ...opts, deps: () => this.mounted });
    this.onpointerdown = this.onpointerdown.bind(this);
    this.onpointerup = this.onpointerup.bind(this);
    this.onpointermove = this.onpointermove.bind(this);
  }
  handleSelect() {
    if (this.opts.disabled.current) return;
    const isCurrentSelectedValue = this.opts.value.current === this.root.opts.value.current;
    if (!this.root.opts.allowDeselect.current && isCurrentSelectedValue && !this.root.isMulti) {
      this.root.handleClose();
      return;
    }
    this.root.toggleItem(this.opts.value.current, this.opts.label.current);
    if (!this.root.isMulti && !isCurrentSelectedValue) {
      this.root.handleClose();
    }
  }
  #snippetProps = once(() => ({
    selected: this.isSelected,
    highlighted: this.isHighlighted
  }));
  get snippetProps() {
    return this.#snippetProps();
  }
  onpointerdown(e) {
    e.preventDefault();
  }
  /**
   * Using `pointerup` instead of `click` allows power users to pointerdown
   * the trigger, then release pointerup on an item to select it vs having to do
   * multiple clicks.
   */
  onpointerup(e) {
    if (e.defaultPrevented || !this.opts.ref.current) return;
    if (e.pointerType === "touch" && !isIOS) {
      on(
        this.opts.ref.current,
        "click",
        () => {
          this.handleSelect();
          this.root.setHighlightedNode(this.opts.ref.current);
        },
        { once: true }
      );
      return;
    }
    e.preventDefault();
    this.handleSelect();
    if (e.pointerType === "touch") {
      this.root.setHighlightedNode(this.opts.ref.current);
    }
  }
  onpointermove(e) {
    if (e.pointerType === "touch") return;
    if (this.root.highlightedNode !== this.opts.ref.current) {
      this.root.setHighlightedNode(this.opts.ref.current);
    }
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "option",
    "aria-selected": this.root.includesItem(this.opts.value.current) ? "true" : void 0,
    "data-value": this.opts.value.current,
    "data-disabled": getDataDisabled(this.opts.disabled.current),
    "data-highlighted": this.root.highlightedValue === this.opts.value.current ? "" : void 0,
    "data-selected": this.root.includesItem(this.opts.value.current) ? "" : void 0,
    "data-label": this.opts.label.current,
    [this.root.bitsAttrs.item]: "",
    onpointermove: this.onpointermove,
    onpointerdown: this.onpointerdown,
    onpointerup: this.onpointerup
  }));
  get props() {
    return this.#props();
  }
}
class SelectHiddenInputState {
  opts;
  root;
  #shouldRender = once(() => this.root.opts.name.current !== "");
  get shouldRender() {
    return this.#shouldRender();
  }
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    this.onfocus = this.onfocus.bind(this);
  }
  onfocus(e) {
    e.preventDefault();
    if (!this.root.isCombobox) {
      this.root.triggerNode?.focus();
    } else {
      this.root.inputNode?.focus();
    }
  }
  #props = once(() => ({
    disabled: getDisabled(this.root.opts.disabled.current),
    required: getRequired(this.root.opts.required.current),
    name: this.root.opts.name.current,
    value: this.opts.value.current,
    onfocus: this.onfocus
  }));
  get props() {
    return this.#props();
  }
}
class SelectViewportState {
  opts;
  content;
  root;
  prevScrollTop = 0;
  constructor(opts, content) {
    this.opts = opts;
    this.content = content;
    this.root = content.root;
    useRefById({
      ...opts,
      onRefChange: (node) => {
        this.content.viewportNode = node;
      },
      deps: () => this.root.opts.open.current
    });
  }
  #props = once(() => ({
    id: this.opts.id.current,
    role: "presentation",
    [this.root.bitsAttrs.viewport]: "",
    style: {
      // we use position: 'relative' here on the `viewport` so that when we call
      // `selectedItem.offsetTop` in calculations, the offset is relative to the viewport
      // (independent of the scrollUpButton).
      position: "relative",
      flex: 1,
      overflow: "auto"
    }
  }));
  get props() {
    return this.#props();
  }
}
const SelectRootContext = new Context("Select.Root | Combobox.Root");
const SelectContentContext = new Context("Select.Content | Combobox.Content");
function useSelectRoot(props) {
  const { type, ...rest } = props;
  const rootState = type === "single" ? new SelectSingleRootState(rest) : new SelectMultipleRootState(rest);
  return SelectRootContext.set(rootState);
}
function useSelectContent(props) {
  return SelectContentContext.set(new SelectContentState(props, SelectRootContext.get()));
}
function useSelectTrigger(props) {
  return new SelectTriggerState(props, SelectRootContext.get());
}
function useSelectItem(props) {
  return new SelectItemState(props, SelectRootContext.get());
}
function useSelectViewport(props) {
  return new SelectViewportState(props, SelectContentContext.get());
}
function useSelectHiddenInput(props) {
  return new SelectHiddenInputState(props, SelectRootContext.get());
}
const selectParts = [
  "trigger",
  "content",
  "item",
  "viewport",
  "scroll-up-button",
  "scroll-down-button",
  "group",
  "group-label",
  "separator",
  "arrow",
  "input",
  "content-wrapper",
  "item-text",
  "value"
];
function getSelectBitsAttrs(root) {
  const isCombobox = root.isCombobox;
  const attrObj = {};
  for (const part of selectParts) {
    attrObj[part] = isCombobox ? `data-combobox-${part}` : `data-select-${part}`;
  }
  return attrObj;
}
function Select_hidden_input($$payload, $$props) {
  push();
  let { value = "" } = $$props;
  const hiddenInputState = useSelectHiddenInput({ value: box.with(() => value) });
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    if (hiddenInputState.shouldRender) {
      $$payload2.out += "<!--[-->";
      Hidden_input($$payload2, spread_props([
        hiddenInputState.props,
        {
          get value() {
            return value;
          },
          set value($$value) {
            value = $$value;
            $$settled = false;
          }
        }
      ]));
    } else {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]-->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { value });
  pop();
}
function Select_content($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    forceMount = false,
    side = "bottom",
    onInteractOutside = noop,
    onEscapeKeydown = noop,
    children,
    child,
    preventScroll = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const contentState = useSelectContent({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    onInteractOutside: box.with(() => onInteractOutside),
    onEscapeKeydown: box.with(() => onEscapeKeydown)
  });
  const mergedProps = mergeProps(restProps, contentState.props);
  if (forceMount) {
    $$payload.out += "<!--[-->";
    {
      let popper = function($$payload2, { props, wrapperProps }) {
        const finalProps = mergeProps(props, { style: contentState.props.style });
        if (child) {
          $$payload2.out += "<!--[-->";
          child($$payload2, {
            props: finalProps,
            wrapperProps,
            ...contentState.snippetProps
          });
          $$payload2.out += `<!---->`;
        } else {
          $$payload2.out += "<!--[!-->";
          $$payload2.out += `<div${spread_attributes({ ...wrapperProps }, null)}><div${spread_attributes({ ...finalProps }, null)}>`;
          children?.($$payload2);
          $$payload2.out += `<!----></div></div>`;
        }
        $$payload2.out += `<!--]-->`;
      };
      Popper_layer_force_mount($$payload, spread_props([
        mergedProps,
        contentState.popperProps,
        {
          side,
          enabled: contentState.root.opts.open.current,
          id,
          preventScroll,
          forceMount: true,
          popper,
          $$slots: { popper: true }
        }
      ]));
    }
  } else if (!forceMount) {
    $$payload.out += "<!--[1-->";
    {
      let popper = function($$payload2, { props, wrapperProps }) {
        const finalProps = mergeProps(props, { style: contentState.props.style });
        if (child) {
          $$payload2.out += "<!--[-->";
          child($$payload2, {
            props: finalProps,
            wrapperProps,
            ...contentState.snippetProps
          });
          $$payload2.out += `<!---->`;
        } else {
          $$payload2.out += "<!--[!-->";
          $$payload2.out += `<div${spread_attributes({ ...wrapperProps }, null)}><div${spread_attributes({ ...finalProps }, null)}>`;
          children?.($$payload2);
          $$payload2.out += `<!----></div></div>`;
        }
        $$payload2.out += `<!--]-->`;
      };
      Popper_layer($$payload, spread_props([
        mergedProps,
        contentState.popperProps,
        {
          side,
          present: contentState.root.opts.open.current,
          id,
          preventScroll,
          forceMount: false,
          popper,
          $$slots: { popper: true }
        }
      ]));
    }
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Mounted($$payload, $$props) {
  push();
  let { mounted = false, onMountedChange = noop } = $$props;
  bind_props($$props, { mounted });
  pop();
}
function Select_item($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    value,
    label = value,
    disabled = false,
    children,
    child,
    onHighlight = noop,
    onUnhighlight = noop,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const itemState = useSelectItem({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    value: box.with(() => value),
    disabled: box.with(() => disabled),
    label: box.with(() => label),
    onHighlight: box.with(() => onHighlight),
    onUnhighlight: box.with(() => onUnhighlight)
  });
  const mergedProps = mergeProps(restProps, itemState.props);
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    if (child) {
      $$payload2.out += "<!--[-->";
      child($$payload2, { props: mergedProps, ...itemState.snippetProps });
      $$payload2.out += `<!---->`;
    } else {
      $$payload2.out += "<!--[!-->";
      $$payload2.out += `<div${spread_attributes({ ...mergedProps }, null)}>`;
      children?.($$payload2, itemState.snippetProps);
      $$payload2.out += `<!----></div>`;
    }
    $$payload2.out += `<!--]--> `;
    Mounted($$payload2, {
      get mounted() {
        return itemState.mounted;
      },
      set mounted($$value) {
        itemState.mounted = $$value;
        $$settled = false;
      }
    });
    $$payload2.out += `<!---->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { ref });
  pop();
}
function Select_viewport($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    children,
    child,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const viewportState = useSelectViewport({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, viewportState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<div${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload);
    $$payload.out += `<!----></div>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Select($$payload, $$props) {
  push();
  let {
    value = void 0,
    onValueChange = noop,
    name = "",
    disabled = false,
    type,
    open = false,
    onOpenChange = noop,
    loop = false,
    scrollAlignment = "nearest",
    required = false,
    items = [],
    allowDeselect = false,
    children
  } = $$props;
  if (value === void 0) {
    const defaultValue = type === "single" ? "" : [];
    value = defaultValue;
  }
  const rootState = useSelectRoot({
    type,
    value: box.with(() => value, (v) => {
      value = v;
      onValueChange(v);
    }),
    disabled: box.with(() => disabled),
    required: box.with(() => required),
    open: box.with(() => open, (v) => {
      open = v;
      onOpenChange(v);
    }),
    loop: box.with(() => loop),
    scrollAlignment: box.with(() => scrollAlignment),
    name: box.with(() => name),
    isCombobox: false,
    items: box.with(() => items),
    allowDeselect: box.with(() => allowDeselect)
  });
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    Floating_layer($$payload2, {
      children: ($$payload3) => {
        children?.($$payload3);
        $$payload3.out += `<!---->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!----> `;
    if (Array.isArray(rootState.opts.value.current)) {
      $$payload2.out += "<!--[-->";
      if (rootState.opts.value.current.length) {
        $$payload2.out += "<!--[-->";
        const each_array = ensure_array_like(rootState.opts.value.current);
        $$payload2.out += `<!--[-->`;
        for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
          let item = each_array[$$index];
          Select_hidden_input($$payload2, { value: item });
        }
        $$payload2.out += `<!--]-->`;
      } else {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]-->`;
    } else {
      $$payload2.out += "<!--[!-->";
      Select_hidden_input($$payload2, {
        get value() {
          return rootState.opts.value.current;
        },
        set value($$value) {
          rootState.opts.value.current = $$value;
          $$settled = false;
        }
      });
    }
    $$payload2.out += `<!--]-->`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  bind_props($$props, { value, open });
  pop();
}
function Select_trigger($$payload, $$props) {
  push();
  let {
    id = useId(),
    ref = null,
    child,
    children,
    type = "button",
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const triggerState = useSelectTrigger({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, triggerState.props, { type });
  $$payload.out += `<!---->`;
  Floating_layer_anchor($$payload, {
    id,
    children: ($$payload2) => {
      if (child) {
        $$payload2.out += "<!--[-->";
        child($$payload2, { props: mergedProps });
        $$payload2.out += `<!---->`;
      } else {
        $$payload2.out += "<!--[!-->";
        $$payload2.out += `<button${spread_attributes({ ...mergedProps }, null)}>`;
        children?.($$payload2);
        $$payload2.out += `<!----></button>`;
      }
      $$payload2.out += `<!--]-->`;
    },
    $$slots: { default: true }
  });
  $$payload.out += `<!---->`;
  bind_props($$props, { ref });
  pop();
}
function AvatarPixel($$payload, $$props) {
  push();
  const ELEMENTS = 64;
  const SIZE = 80;
  function generateColors(name2, colors2) {
    const numFromName = getNumber(name2);
    const range = colors2 && colors2.length;
    const elementsProperties = Array.from({ length: ELEMENTS }, (_, i) => ({
      color: getRandomColor(numFromName % (i + 13), colors2, range)
    }));
    return elementsProperties;
  }
  let size = fallback($$props["size"], () => DEFAULTS.size, true);
  let name = fallback($$props["name"], () => DEFAULTS.name, true);
  let square = fallback($$props["square"], () => DEFAULTS.square, true);
  let colors = fallback($$props["colors"], () => DEFAULTS.colors, true);
  const properties = generateColors(name, colors);
  const maskId = `mask0${getRandomId()}`;
  $$payload.out += `<svg${attr("viewBox", "0 0 " + SIZE + " " + SIZE)} fill="none" xmlns="http://www.w3.org/2000/svg"${attr("width", size)}${attr("height", size)} data-testid="avatar-pixel"><mask${attr("id", maskId)} maskUnits="userSpaceOnUse"${attr("x", 0)}${attr("y", 0)}${attr("width", SIZE)}${attr("height", SIZE)}${attr_style("", { "mask-type": "alpha" })}><rect${attr("width", SIZE)}${attr("height", SIZE)}${attr("rx", square ? void 0 : SIZE * 2)} fill="white"></rect></mask><g${attr("mask", `url(#${stringify(maskId)})`)}><rect${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[0].color)}></rect><rect${attr("x", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[1].color)}></rect><rect${attr("x", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[2].color)}></rect><rect${attr("x", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[3].color)}></rect><rect${attr("x", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[4].color)}></rect><rect${attr("x", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[5].color)}></rect><rect${attr("x", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[6].color)}></rect><rect${attr("x", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[7].color)}></rect><rect${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[8].color)}></rect><rect${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[9].color)}></rect><rect${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[10].color)}></rect><rect${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[11].color)}></rect><rect${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[12].color)}></rect><rect${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[13].color)}></rect><rect${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[14].color)}></rect><rect${attr("x", 20)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[15].color)}></rect><rect${attr("x", 20)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[16].color)}></rect><rect${attr("x", 20)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[17].color)}></rect><rect${attr("x", 20)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[18].color)}></rect><rect${attr("x", 20)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[19].color)}></rect><rect${attr("x", 20)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[20].color)}></rect><rect${attr("x", 20)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[21].color)}></rect><rect${attr("x", 40)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[22].color)}></rect><rect${attr("x", 40)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[23].color)}></rect><rect${attr("x", 40)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[24].color)}></rect><rect${attr("x", 40)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[25].color)}></rect><rect${attr("x", 40)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[26].color)}></rect><rect${attr("x", 40)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[27].color)}></rect><rect${attr("x", 40)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[28].color)}></rect><rect${attr("x", 60)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[29].color)}></rect><rect${attr("x", 60)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[30].color)}></rect><rect${attr("x", 60)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[31].color)}></rect><rect${attr("x", 60)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[32].color)}></rect><rect${attr("x", 60)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[33].color)}></rect><rect${attr("x", 60)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[34].color)}></rect><rect${attr("x", 60)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[35].color)}></rect><rect${attr("x", 10)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[36].color)}></rect><rect${attr("x", 10)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[37].color)}></rect><rect${attr("x", 10)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[38].color)}></rect><rect${attr("x", 10)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[39].color)}></rect><rect${attr("x", 10)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[40].color)}></rect><rect${attr("x", 10)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[41].color)}></rect><rect${attr("x", 10)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[42].color)}></rect><rect${attr("x", 30)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[43].color)}></rect><rect${attr("x", 30)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[44].color)}></rect><rect${attr("x", 30)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[45].color)}></rect><rect${attr("x", 30)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[46].color)}></rect><rect${attr("x", 30)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[47].color)}></rect><rect${attr("x", 30)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[48].color)}></rect><rect${attr("x", 30)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[49].color)}></rect><rect${attr("x", 50)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[50].color)}></rect><rect${attr("x", 50)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[51].color)}></rect><rect${attr("x", 50)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[52].color)}></rect><rect${attr("x", 50)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[53].color)}></rect><rect${attr("x", 50)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[54].color)}></rect><rect${attr("x", 50)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[55].color)}></rect><rect${attr("x", 50)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[56].color)}></rect><rect${attr("x", 70)}${attr("y", 10)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[57].color)}></rect><rect${attr("x", 70)}${attr("y", 20)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[58].color)}></rect><rect${attr("x", 70)}${attr("y", 30)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[59].color)}></rect><rect${attr("x", 70)}${attr("y", 40)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[60].color)}></rect><rect${attr("x", 70)}${attr("y", 50)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[61].color)}></rect><rect${attr("x", 70)}${attr("y", 60)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[62].color)}></rect><rect${attr("x", 70)}${attr("y", 70)}${attr("width", 10)}${attr("height", 10)}${attr("fill", properties[63].color)}></rect></g></svg>`;
  bind_props($$props, { size, name, square, colors });
  pop();
}
function calculateOffset(toast2, $toasts, opts) {
  const { reverseOrder, gutter = 8, defaultPosition } = opts || {};
  const relevantToasts = $toasts.filter((t) => (t.position || defaultPosition) === (toast2.position || defaultPosition) && t.height);
  const toastIndex = relevantToasts.findIndex((t) => t.id === toast2.id);
  const toastsBefore = relevantToasts.filter((toast3, i) => i < toastIndex && toast3.visible).length;
  const offset = relevantToasts.filter((t) => t.visible).slice(...reverseOrder ? [toastsBefore + 1] : [0, toastsBefore]).reduce((acc, t) => acc + (t.height || 0) + gutter, 0);
  return offset;
}
const handlers = {
  startPause() {
    startPause(Date.now());
  },
  endPause() {
    endPause(Date.now());
  },
  updateHeight: (toastId, height) => {
    update({ id: toastId, height }, false);
  },
  calculateOffset
};
function useToaster(toastOptions) {
  const { toasts, pausedAt } = useToasterStore(toastOptions);
  const timeouts = /* @__PURE__ */ new Map();
  let _pausedAt;
  const unsubscribes = [
    pausedAt.subscribe(($pausedAt) => {
      if ($pausedAt) {
        for (const [, timeoutId] of timeouts) {
          clearTimeout(timeoutId);
        }
        timeouts.clear();
      }
      _pausedAt = $pausedAt;
    }),
    toasts.subscribe(($toasts) => {
      if (_pausedAt) {
        return;
      }
      const now = Date.now();
      for (const t of $toasts) {
        if (timeouts.has(t.id)) {
          continue;
        }
        if (t.duration === Infinity) {
          continue;
        }
        const durationLeft = (t.duration || 0) + t.pauseDuration - (now - t.createdAt);
        if (durationLeft < 0) {
          if (t.visible) {
            toast.dismiss(t.id);
          }
          return null;
        }
        timeouts.set(t.id, setTimeout(() => toast.dismiss(t.id), durationLeft));
      }
    })
  ];
  onDestroy(() => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  });
  return { toasts, handlers };
}
function CheckmarkIcon($$payload, $$props) {
  let { primary = "#61d345", secondary = "#fff" } = $$props;
  $$payload.out += `<div class="svelte-11kvm4p"${attr_style("", {
    "--primary": primary,
    "--secondary": secondary
  })}></div>`;
}
function ErrorIcon($$payload, $$props) {
  let { primary = "#ff4b4b", secondary = "#fff" } = $$props;
  $$payload.out += `<div class="svelte-1ee93ns"${attr_style("", {
    "--primary": primary,
    "--secondary": secondary
  })}></div>`;
}
function LoaderIcon($$payload, $$props) {
  let { primary = "#616161", secondary = "#e0e0e0" } = $$props;
  $$payload.out += `<div class="svelte-1j7dflg"${attr_style("", {
    "--primary": primary,
    "--secondary": secondary
  })}></div>`;
}
function ToastIcon($$payload, $$props) {
  let { toast: toast2 } = $$props;
  let { type, icon, iconTheme } = toast2;
  if (typeof icon === "string") {
    $$payload.out += "<!--[-->";
    $$payload.out += `<div class="animated svelte-1kgeier">${escape_html(icon)}</div>`;
  } else if (typeof icon !== "undefined") {
    $$payload.out += "<!--[1-->";
    const IconComponent = icon;
    $$payload.out += `<!---->`;
    IconComponent($$payload, {});
    $$payload.out += `<!---->`;
  } else if (type !== "blank") {
    $$payload.out += "<!--[2-->";
    $$payload.out += `<div class="indicator svelte-1kgeier">`;
    LoaderIcon($$payload, spread_props([iconTheme]));
    $$payload.out += `<!----> `;
    if (type !== "loading") {
      $$payload.out += "<!--[-->";
      $$payload.out += `<div class="status svelte-1kgeier">`;
      if (type === "error") {
        $$payload.out += "<!--[-->";
        ErrorIcon($$payload, spread_props([iconTheme]));
      } else {
        $$payload.out += "<!--[!-->";
        CheckmarkIcon($$payload, spread_props([iconTheme]));
      }
      $$payload.out += `<!--]--></div>`;
    } else {
      $$payload.out += "<!--[!-->";
    }
    $$payload.out += `<!--]--></div>`;
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
}
function ToastMessage($$payload, $$props) {
  push();
  let { toast: toast2 } = $$props;
  $$payload.out += `<div${spread_attributes({ class: "message", ...toast2.ariaProps }, "svelte-1nauejd")}>`;
  if (typeof toast2.message === "string") {
    $$payload.out += "<!--[-->";
    $$payload.out += `${escape_html(toast2.message)}`;
  } else {
    $$payload.out += "<!--[!-->";
    const Message = toast2.message;
    $$payload.out += `<!---->`;
    Message($$payload, spread_props([{ toast: toast2 }, toast2.props]));
    $$payload.out += `<!---->`;
  }
  $$payload.out += `<!--]--></div>`;
  pop();
}
function ToastBar($$payload, $$props) {
  push();
  let {
    toast: toast2,
    position = void 0,
    style = "",
    Component = void 0,
    children
  } = $$props;
  let factor = (() => {
    const top = (toast2.position || position || "top-center").includes("top");
    return top ? 1 : -1;
  })();
  let animation = (() => {
    const [enter, exit] = prefersReducedMotion() ? ["fadeIn", "fadeOut"] : ["enter", "exit"];
    return toast2.visible ? enter : exit;
  })();
  $$payload.out += `<div${attr_class(`base ${stringify(toast2.height ? animation : "transparent")} ${stringify(toast2.className || "")}`, "svelte-1c9srrs")}${attr_style(`${stringify(style)}; ${stringify(toast2.style)}`, { "--factor": factor })}>`;
  if (Component) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<!---->`;
    {
      let icon = function($$payload2) {
        ToastIcon($$payload2, { toast: toast2 });
      }, message = function($$payload2) {
        ToastMessage($$payload2, { toast: toast2 });
      };
      Component($$payload, {
        icon,
        message,
        $$slots: { icon: true, message: true }
      });
    }
    $$payload.out += `<!---->`;
  } else if (children) {
    $$payload.out += "<!--[1-->";
    children($$payload, { ToastIcon, ToastMessage, toast: toast2 });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    ToastIcon($$payload, { toast: toast2 });
    $$payload.out += `<!----> `;
    ToastMessage($$payload, { toast: toast2 });
    $$payload.out += `<!---->`;
  }
  $$payload.out += `<!--]--></div>`;
  pop();
}
function ToastWrapper($$payload, $$props) {
  push();
  let { toast: toast2, setHeight, children } = $$props;
  let top = toast2.position?.includes("top") ? 0 : null;
  let bottom = toast2.position?.includes("bottom") ? 0 : null;
  let factor = toast2.position?.includes("top") ? 1 : -1;
  let justifyContent = toast2.position?.includes("center") && "center" || (toast2.position?.includes("right") || toast2.position?.includes("end")) && "flex-end" || null;
  $$payload.out += `<div${attr_class("wrapper svelte-v01oml", void 0, {
    "active": toast2.visible,
    "transition": !prefersReducedMotion()
  })}${attr_style("", {
    "--factor": factor,
    "--offset": toast2.offset,
    top,
    bottom,
    "justify-content": justifyContent
  })}>`;
  if (toast2.type === "custom") {
    $$payload.out += "<!--[-->";
    ToastMessage($$payload, { toast: toast2 });
  } else if (children) {
    $$payload.out += "<!--[1-->";
    children($$payload, { toast: toast2 });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    ToastBar($$payload, { toast: toast2, position: toast2.position });
  }
  $$payload.out += `<!--]--></div>`;
  pop();
}
function Toaster($$payload, $$props) {
  push();
  var $$store_subs;
  let {
    reverseOrder = false,
    position = "top-center",
    toastOptions = void 0,
    gutter = 8,
    containerStyle = void 0,
    containerClassName = void 0
  } = $$props;
  const { toasts, handlers: handlers2 } = useToaster(toastOptions);
  let _toasts = store_get($$store_subs ??= {}, "$toasts", toasts).map((toast2) => ({
    ...toast2,
    position: toast2.position || position,
    offset: handlers2.calculateOffset(toast2, store_get($$store_subs ??= {}, "$toasts", toasts), {
      reverseOrder,
      gutter,
      defaultPosition: position
    })
  }));
  const each_array = ensure_array_like(_toasts);
  $$payload.out += `<div${attr_class(`toaster ${stringify(containerClassName || "")}`, "svelte-1phplh9")}${attr_style(containerStyle)} role="alert"><!--[-->`;
  for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
    let toast2 = each_array[$$index];
    ToastWrapper($$payload, {
      toast: toast2,
      setHeight: (height) => handlers2.updateHeight(toast2.id, height)
    });
  }
  $$payload.out += `<!--]--></div>`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  pop();
}
const themes = [
  "abyss",
  "acid",
  "aqua",
  "autumn",
  "black",
  "bumblebee",
  "business",
  "caramellatte",
  "cmyk",
  "coffee",
  "corporate",
  "cupcake",
  "cyberpunk",
  "dark",
  "dim",
  "dracula",
  "emerald",
  "fantasy",
  "forest",
  "garden",
  "halloween",
  "lemonade",
  "light",
  "lofi",
  "luxury",
  "night",
  "nord",
  "pastel",
  "retro",
  "silk",
  "sunset",
  "synthwave",
  "valentine",
  "winter",
  "wireframe"
];
function ThemeSelector($$payload, $$props) {
  push();
  const selectItems = themes.map((t) => {
    return {
      value: t,
      label: `${t[0].toUpperCase()}${t.slice(1)}`
    };
  });
  function setTheme(theme) {
    window.localStorage.setItem("theme", theme);
    document.cookie = `theme=${theme}; path=/`;
    document.documentElement.setAttribute("data-theme", theme);
  }
  $$payload.out += `<!---->`;
  Select($$payload, {
    type: "single",
    items: selectItems,
    onValueChange: setTheme,
    children: ($$payload2) => {
      $$payload2.out += `<!---->`;
      Select_trigger($$payload2, {
        class: "btn btn-ghost hover:bg-base-200 cursor-pointer",
        children: ($$payload3) => {
          Icon($$payload3, {
            icon: "material-symbols:palette-outline",
            class: "size-6"
          });
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!----> <!---->`;
      Portal($$payload2, {
        children: ($$payload3) => {
          $$payload3.out += `<!---->`;
          Select_content($$payload3, {
            side: "right",
            sideOffset: 8,
            class: "w-fit h-48 bg-base-300 p-2 rounded",
            children: ($$payload4) => {
              $$payload4.out += `<!---->`;
              Select_viewport($$payload4, {
                children: ($$payload5) => {
                  const each_array = ensure_array_like(selectItems);
                  $$payload5.out += `<!--[-->`;
                  for (let i = 0, $$length = each_array.length; i < $$length; i++) {
                    let theme = each_array[i];
                    $$payload5.out += `<!---->`;
                    {
                      let children = function($$payload6, { selected }) {
                        $$payload6.out += `<span class="px-1 py-2 rounded cursor-pointer hover:bg-base-100 flex gap-2 items-center">${escape_html(theme.label)} `;
                        if (selected) {
                          $$payload6.out += "<!--[-->";
                          Icon($$payload6, { icon: "material-symbols:check-rounded" });
                        } else {
                          $$payload6.out += "<!--[!-->";
                        }
                        $$payload6.out += `<!--]--></span>`;
                      };
                      Select_item($$payload5, {
                        value: theme.value,
                        label: theme.label,
                        children,
                        $$slots: { default: true }
                      });
                    }
                    $$payload5.out += `<!---->`;
                  }
                  $$payload5.out += `<!--]-->`;
                },
                $$slots: { default: true }
              });
              $$payload4.out += `<!---->`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!---->`;
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    },
    $$slots: { default: true }
  });
  $$payload.out += `<!---->`;
  pop();
}
function _layout($$payload, $$props) {
  push();
  let { children } = $$props;
  let handleInput = "";
  let isLoginDialogOpen = !user.session;
  let newSpaceName = "";
  let deleteLoading = false;
  let isNewSpaceDialogOpen = false;
  let servers = g.catalog?.view.spaces.map((x) => x.id) || [];
  let currentCatalog = "";
  async function deleteData(kind) {
    deleteLoading = true;
    if (kind == "all" && user.agent?.did) {
      await new RoomyPdsStorageAdapter(user.agent).removeRange([]);
    }
    localStorage.clear();
    indexedDB.databases().then((dbs) => {
      dbs.forEach((db) => {
        if (db.name) indexedDB.deleteDatabase(db.name);
      });
    });
    window.location.reload();
  }
  let $$settled = true;
  let $$inner_payload;
  function $$render_inner($$payload2) {
    head($$payload2, ($$payload3) => {
      $$payload3.title = `<title>Roomy</title>`;
    });
    {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--> <div class="flex w-screen h-screen bg-base-100">`;
    Toaster($$payload2, {});
    $$payload2.out += `<!----> <aside class="w-fit col-span-2 flex flex-col justify-between px-4 py-8 items-center border-r-2 border-base-200"><!---->`;
    Toggle_group($$payload2, {
      type: "single",
      value: currentCatalog,
      class: "flex flex-col gap-2 items-center",
      children: ($$payload3) => {
        const each_array = ensure_array_like(servers);
        $$payload3.out += `<!---->`;
        Toggle_group_item($$payload3, {
          value: "home",
          onclick: () => goto(),
          class: "btn btn-ghost size-16 data-[state=on]:border-accent",
          children: ($$payload4) => {
            Icon($$payload4, {
              icon: "iconamoon:home-fill",
              "font-size": "2em"
            });
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!----> <div class="divider mt-0 mb-1"></div> <!--[-->`;
        for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
          let server = each_array[$$index];
          const space = g.spaces[server];
          if (space) {
            $$payload3.out += "<!--[-->";
            $$payload3.out += `<!---->`;
            Toggle_group_item($$payload3, {
              onclick: () => goto(),
              value: server,
              title: space.view.name,
              class: "btn btn-ghost size-16 data-[state=on]:border-primary",
              children: ($$payload4) => {
                $$payload4.out += `<!---->`;
                Avatar($$payload4, {
                  children: ($$payload5) => {
                    $$payload5.out += `<!---->`;
                    Avatar_image($$payload5, {});
                    $$payload5.out += `<!----> <!---->`;
                    Avatar_fallback($$payload5, {
                      children: ($$payload6) => {
                        AvatarPixel($$payload6, { name: server });
                      },
                      $$slots: { default: true }
                    });
                    $$payload5.out += `<!---->`;
                  },
                  $$slots: { default: true }
                });
                $$payload4.out += `<!---->`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!---->`;
          } else {
            $$payload3.out += "<!--[!-->";
          }
          $$payload3.out += `<!--]-->`;
        }
        $$payload3.out += `<!--]-->`;
      },
      $$slots: { default: true }
    });
    $$payload2.out += `<!----> <section class="menu gap-3">`;
    ThemeSelector($$payload2);
    $$payload2.out += `<!----> `;
    {
      let dialogTrigger = function($$payload3) {
        $$payload3.out += `<!---->`;
        Button($$payload3, {
          title: "Create Space",
          class: "btn btn-ghost w-fit",
          children: ($$payload4) => {
            Icon($$payload4, { icon: "basil:add-solid", "font-size": "2em" });
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!---->`;
      };
      Dialog_1($$payload2, {
        title: "Create Space",
        description: "Create a new public chat space",
        get isDialogOpen() {
          return isNewSpaceDialogOpen;
        },
        set isDialogOpen($$value) {
          isNewSpaceDialogOpen = $$value;
          $$settled = false;
        },
        dialogTrigger,
        children: ($$payload3) => {
          $$payload3.out += `<form class="flex flex-col gap-4"><input${attr("value", newSpaceName)} placeholder="Name" class="input w-full"> <!---->`;
          Button($$payload3, {
            disabled: true,
            class: "btn btn-primary",
            children: ($$payload4) => {
              Icon($$payload4, {
                icon: "basil:add-outline",
                "font-size": "1.8em"
              });
              $$payload4.out += `<!----> Create Space`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----></form>`;
        },
        $$slots: { dialogTrigger: true, default: true }
      });
    }
    $$payload2.out += `<!----> `;
    {
      let dialogTrigger = function($$payload3) {
        $$payload3.out += `<!---->`;
        Button($$payload3, {
          class: "btn btn-ghost w-fit",
          children: ($$payload4) => {
            Icon($$payload4, {
              icon: "ri:alarm-warning-fill",
              class: "text-2xl"
            });
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!---->`;
      };
      Dialog_1($$payload2, {
        title: "Delete Data",
        dialogTrigger,
        children: ($$payload3) => {
          $$payload3.out += `<div class="flex flex-col items-center gap-4"><p class="text-sm"><strong>Warning:</strong> This will delete the Roomy data from this device
            and from your AtProto PDS if you chose.</p> <p class="text-sm">Roomy is currently <em>extremely</em> experimental, so until it gets
            a little more stable it may be necessary to reset all of your data in
            order to fix a problem after an update of Roomy is published.</p> <!---->`;
          Button($$payload3, {
            onclick: () => deleteData("local"),
            class: "btn btn-error",
            disabled: deleteLoading,
            children: ($$payload4) => {
              if (deleteLoading) {
                $$payload4.out += "<!--[-->";
                $$payload4.out += `<span class="loading loading-spinner"></span>`;
              } else {
                $$payload4.out += "<!--[!-->";
              }
              $$payload4.out += `<!--]--> Delete Local Data`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----> <!---->`;
          Button($$payload3, {
            onclick: () => deleteData("all"),
            class: "btn btn-error",
            disabled: deleteLoading,
            children: ($$payload4) => {
              if (deleteLoading) {
                $$payload4.out += "<!--[-->";
                $$payload4.out += `<span class="loading loading-spinner"></span>`;
              } else {
                $$payload4.out += "<!--[!-->";
              }
              $$payload4.out += `<!--]--> Delete Local and PDS Data`;
            },
            $$slots: { default: true }
          });
          $$payload3.out += `<!----></div>`;
        },
        $$slots: { dialogTrigger: true, default: true }
      });
    }
    $$payload2.out += `<!----> `;
    {
      $$payload2.out += "<!--[!-->";
    }
    $$payload2.out += `<!--]--> `;
    {
      let dialogTrigger = function($$payload3) {
        $$payload3.out += `<!---->`;
        Button($$payload3, {
          class: "btn btn-ghost w-fit",
          children: ($$payload4) => {
            AvatarImage($$payload4, {
              handle: user.profile.data?.handle || "",
              avatarUrl: user.profile.data?.avatar
            });
          },
          $$slots: { default: true }
        });
        $$payload3.out += `<!---->`;
      };
      Dialog_1($$payload2, {
        title: user.session ? `Logged In As ${user.profile.data?.handle}` : "Login with AT Protocol",
        get isDialogOpen() {
          return isLoginDialogOpen;
        },
        set isDialogOpen($$value) {
          isLoginDialogOpen = $$value;
          $$settled = false;
        },
        dialogTrigger,
        children: ($$payload3) => {
          if (user.session) {
            $$payload3.out += "<!--[-->";
            $$payload3.out += `<section class="flex flex-col gap-4"><!---->`;
            Button($$payload3, {
              onclick: user.logout,
              class: "btn btn-error",
              children: ($$payload4) => {
                $$payload4.out += `<!---->Logout`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!----></section>`;
          } else {
            $$payload3.out += "<!--[!-->";
            $$payload3.out += `<form class="flex flex-col gap-4">`;
            {
              $$payload3.out += "<!--[!-->";
            }
            $$payload3.out += `<!--]--> <input${attr("value", handleInput)} placeholder="Handle (eg alice.bsky.social)" class="input w-full"> <!---->`;
            Button($$payload3, {
              disabled: true,
              class: "btn btn-primary",
              children: ($$payload4) => {
                {
                  $$payload4.out += "<!--[!-->";
                }
                $$payload4.out += `<!--]--> Login with Bluesky`;
              },
              $$slots: { default: true }
            });
            $$payload3.out += `<!----></form>`;
          }
          $$payload3.out += `<!--]-->`;
        },
        $$slots: { dialogTrigger: true, default: true }
      });
    }
    $$payload2.out += `<!----></section></aside> `;
    children($$payload2);
    $$payload2.out += `<!----></div>`;
  }
  do {
    $$settled = true;
    $$inner_payload = copy_payload($$payload);
    $$render_inner($$inner_payload);
  } while (!$$settled);
  assign_payload($$payload, $$inner_payload);
  pop();
}
export {
  _layout as default
};
