import { w as push, a1 as getAllContexts, y as pop, A as once, G as spread_attributes, E as bind_props, F as spread_props, J as fallback, K as attr, N as stringify } from "./index.js";
import { m as mount, u as unmount } from "./Icon.js";
import { J as defaultWindow, K as isBrowser, w as watch, b as box, n as noop, u as useRefById, a as afterTick, L as executeCallbacks, G as isElement$1, M as ESCAPE, m as useId, N as isSelectableInput, O as isElementHidden, C as Context, T as TAB, Q as isHTMLElement$1, R as composeHandlers, o as mergeProps, U as srOnlyStylesString, V as cssToStyleObj, W as isNotNull, X as styleToString, t as Presence_layer } from "./button.js";
import { o as on } from "./events.js";
import { i as derived, j as get$1, w as writable } from "./exports.js";
class ElementSize {
  #size = { width: 0, height: 0 };
  constructor(node, options = { box: "border-box" }) {
    options.window ?? defaultWindow;
    this.#size = {
      width: options.initialSize?.width ?? 0,
      height: options.initialSize?.height ?? 0
    };
  }
  get current() {
    return this.#size;
  }
  get width() {
    return this.#size.width;
  }
  get height() {
    return this.#size.height;
  }
}
function afterSleep(ms, cb) {
  return setTimeout(cb, ms);
}
function Portal($$payload, $$props) {
  push();
  let { to = "body", children, disabled } = $$props;
  getAllContexts();
  let target = getTarget();
  function getTarget() {
    if (!isBrowser || disabled) return null;
    let localTarget = null;
    if (typeof to === "string") {
      localTarget = document.querySelector(to);
    } else if (to instanceof HTMLElement || to instanceof DocumentFragment) {
      localTarget = to;
    } else ;
    return localTarget;
  }
  let instance;
  function unmountInstance() {
    if (instance) {
      unmount();
      instance = null;
    }
  }
  watch([() => target, () => disabled], ([target2, disabled2]) => {
    if (!target2 || disabled2) {
      unmountInstance();
      return;
    }
    instance = mount();
    return () => {
      unmountInstance();
    };
  });
  if (disabled) {
    $$payload.out += "<!--[-->";
    children?.($$payload);
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
  }
  $$payload.out += `<!--]-->`;
  pop();
}
function addEventListener(target, event, handler, options) {
  const events = Array.isArray(event) ? event : [event];
  events.forEach((_event) => target.addEventListener(_event, handler, options));
  return () => {
    events.forEach((_event) => target.removeEventListener(_event, handler, options));
  };
}
class CustomEventDispatcher {
  eventName;
  options;
  constructor(eventName, options = { bubbles: true, cancelable: true }) {
    this.eventName = eventName;
    this.options = options;
  }
  createEvent(detail) {
    return new CustomEvent(this.eventName, {
      ...this.options,
      detail
    });
  }
  dispatch(element, detail) {
    const event = this.createEvent(detail);
    element.dispatchEvent(event);
    return event;
  }
  listen(element, callback, options) {
    const handler = (event) => {
      callback(event);
    };
    return on(element, this.eventName, handler, options);
  }
}
function debounce(fn, wait = 500) {
  let timeout = null;
  const debounced = (...args) => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      fn(...args);
    }, wait);
  };
  debounced.destroy = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  return debounced;
}
function isOrContainsTarget(node, target) {
  return node === target || node.contains(target);
}
function getOwnerDocument(el) {
  return el?.ownerDocument ?? document;
}
function isClickTrulyOutside(event, contentNode) {
  const { clientX, clientY } = event;
  const rect = contentNode.getBoundingClientRect();
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}
globalThis.bitsDismissableLayers ??= /* @__PURE__ */ new Map();
class DismissibleLayerState {
  opts;
  #interactOutsideProp;
  #behaviorType;
  #interceptedEvents = { pointerdown: false };
  #isResponsibleLayer = false;
  #isFocusInsideDOMTree = false;
  node = box(null);
  #documentObj = void 0;
  #onFocusOutside;
  currNode = null;
  #unsubClickListener = noop;
  constructor(opts) {
    this.opts = opts;
    useRefById({
      id: opts.id,
      ref: this.node,
      deps: () => opts.enabled.current,
      onRefChange: (node) => {
        this.currNode = node;
      }
    });
    this.#behaviorType = opts.interactOutsideBehavior;
    this.#interactOutsideProp = opts.onInteractOutside;
    this.#onFocusOutside = opts.onFocusOutside;
    let unsubEvents = noop;
    const cleanup = () => {
      this.#resetState();
      globalThis.bitsDismissableLayers.delete(this);
      this.#handleInteractOutside.destroy();
      unsubEvents();
    };
    watch(
      [
        () => this.opts.enabled.current,
        () => this.currNode
      ],
      ([enabled, currNode]) => {
        if (!enabled || !currNode) return;
        afterSleep(1, () => {
          if (!this.currNode) return;
          globalThis.bitsDismissableLayers.set(this, this.#behaviorType);
          unsubEvents();
          unsubEvents = this.#addEventListeners();
        });
        return cleanup;
      }
    );
  }
  #handleFocus = (event) => {
    if (event.defaultPrevented) return;
    if (!this.currNode) return;
    afterTick(() => {
      if (!this.currNode || this.#isTargetWithinLayer(event.target)) return;
      if (event.target && !this.#isFocusInsideDOMTree) {
        this.#onFocusOutside.current?.(event);
      }
    });
  };
  #addEventListeners() {
    return executeCallbacks(
      /**
      * CAPTURE INTERACTION START
      * mark interaction-start event as intercepted.
      * mark responsible layer during interaction start
      * to avoid checking if is responsible layer during interaction end
      * when a new floating element may have been opened.
      */
      on(this.#documentObj, "pointerdown", executeCallbacks(this.#markInterceptedEvent, this.#markResponsibleLayer), { capture: true }),
      /**
      * BUBBLE INTERACTION START
      * Mark interaction-start event as non-intercepted. Debounce `onInteractOutsideStart`
      * to avoid prematurely checking if other events were intercepted.
      */
      on(this.#documentObj, "pointerdown", executeCallbacks(this.#markNonInterceptedEvent, this.#handleInteractOutside)),
      /**
      * HANDLE FOCUS OUTSIDE
      */
      on(this.#documentObj, "focusin", this.#handleFocus)
    );
  }
  #handleDismiss = (e) => {
    let event = e;
    if (event.defaultPrevented) {
      event = createWrappedEvent(e);
    }
    this.#interactOutsideProp.current(e);
  };
  #handleInteractOutside = debounce(
    (e) => {
      if (!this.currNode) {
        this.#unsubClickListener();
        return;
      }
      const isEventValid = this.opts.isValidEvent.current(e, this.currNode) || isValidEvent(e, this.currNode);
      if (!this.#isResponsibleLayer || this.#isAnyEventIntercepted() || !isEventValid) {
        this.#unsubClickListener();
        return;
      }
      let event = e;
      if (event.defaultPrevented) {
        event = createWrappedEvent(event);
      }
      if (this.#behaviorType.current !== "close" && this.#behaviorType.current !== "defer-otherwise-close") {
        this.#unsubClickListener();
        return;
      }
      if (e.pointerType === "touch") {
        this.#unsubClickListener();
        this.#unsubClickListener = addEventListener(this.#documentObj, "click", this.#handleDismiss, { once: true });
      } else {
        this.#interactOutsideProp.current(event);
      }
    },
    10
  );
  #markInterceptedEvent = (e) => {
    this.#interceptedEvents[e.type] = true;
  };
  #markNonInterceptedEvent = (e) => {
    this.#interceptedEvents[e.type] = false;
  };
  #markResponsibleLayer = () => {
    if (!this.node.current) return;
    this.#isResponsibleLayer = isResponsibleLayer(this.node.current);
  };
  #isTargetWithinLayer = (target) => {
    if (!this.node.current) return false;
    return isOrContainsTarget(this.node.current, target);
  };
  #resetState = debounce(
    () => {
      for (const eventType in this.#interceptedEvents) {
        this.#interceptedEvents[eventType] = false;
      }
      this.#isResponsibleLayer = false;
    },
    20
  );
  #isAnyEventIntercepted() {
    const i = Object.values(this.#interceptedEvents).some(Boolean);
    return i;
  }
  #onfocuscapture = () => {
    this.#isFocusInsideDOMTree = true;
  };
  #onblurcapture = () => {
    this.#isFocusInsideDOMTree = false;
  };
  props = {
    onfocuscapture: this.#onfocuscapture,
    onblurcapture: this.#onblurcapture
  };
}
function useDismissibleLayer(props) {
  return new DismissibleLayerState(props);
}
function getTopMostLayer(layersArr) {
  return layersArr.findLast(([_, { current: behaviorType }]) => behaviorType === "close" || behaviorType === "ignore");
}
function isResponsibleLayer(node) {
  const layersArr = [...globalThis.bitsDismissableLayers];
  const topMostLayer = getTopMostLayer(layersArr);
  if (topMostLayer) return topMostLayer[0].node.current === node;
  const [firstLayerNode] = layersArr[0];
  return firstLayerNode.node.current === node;
}
function isValidEvent(e, node) {
  if ("button" in e && e.button > 0) return false;
  const target = e.target;
  if (!isElement$1(target)) return false;
  const ownerDocument = getOwnerDocument(target);
  const isValid = ownerDocument.documentElement.contains(target) && !isOrContainsTarget(node, target) && isClickTrulyOutside(e, node);
  return isValid;
}
function createWrappedEvent(e) {
  const capturedCurrentTarget = e.currentTarget;
  const capturedTarget = e.target;
  let newEvent;
  if (e instanceof PointerEvent) {
    newEvent = new PointerEvent(e.type, e);
  } else {
    newEvent = new PointerEvent("pointerdown", e);
  }
  let isPrevented = false;
  const wrappedEvent = new Proxy(newEvent, {
    get: (target, prop) => {
      if (prop === "currentTarget") {
        return capturedCurrentTarget;
      }
      if (prop === "target") {
        return capturedTarget;
      }
      if (prop === "preventDefault") {
        return () => {
          isPrevented = true;
          if (typeof target.preventDefault === "function") {
            target.preventDefault();
          }
        };
      }
      if (prop === "defaultPrevented") {
        return isPrevented;
      }
      if (prop in target) {
        return target[prop];
      }
      return e[prop];
    }
  });
  return wrappedEvent;
}
function Dismissible_layer($$payload, $$props) {
  push();
  let {
    interactOutsideBehavior = "close",
    onInteractOutside = noop,
    onFocusOutside = noop,
    id,
    children,
    enabled,
    isValidEvent: isValidEvent2 = () => false
  } = $$props;
  const dismissibleLayerState = useDismissibleLayer({
    id: box.with(() => id),
    interactOutsideBehavior: box.with(() => interactOutsideBehavior),
    onInteractOutside: box.with(() => onInteractOutside),
    enabled: box.with(() => enabled),
    onFocusOutside: box.with(() => onFocusOutside),
    isValidEvent: box.with(() => isValidEvent2)
  });
  children?.($$payload, { props: dismissibleLayerState.props });
  $$payload.out += `<!---->`;
  pop();
}
globalThis.bitsEscapeLayers ??= /* @__PURE__ */ new Map();
class EscapeLayerState {
  opts;
  constructor(opts) {
    this.opts = opts;
    let unsubEvents = noop;
    watch(() => opts.enabled.current, (enabled) => {
      if (enabled) {
        globalThis.bitsEscapeLayers.set(this, opts.escapeKeydownBehavior);
        unsubEvents = this.#addEventListener();
      }
      return () => {
        unsubEvents();
        globalThis.bitsEscapeLayers.delete(this);
      };
    });
  }
  #addEventListener = () => {
    return on(document, "keydown", this.#onkeydown, { passive: false });
  };
  #onkeydown = (e) => {
    if (e.key !== ESCAPE || !isResponsibleEscapeLayer(this)) return;
    const clonedEvent = new KeyboardEvent(e.type, e);
    e.preventDefault();
    const behaviorType = this.opts.escapeKeydownBehavior.current;
    if (behaviorType !== "close" && behaviorType !== "defer-otherwise-close") return;
    this.opts.onEscapeKeydown.current(clonedEvent);
  };
}
function useEscapeLayer(props) {
  return new EscapeLayerState(props);
}
function isResponsibleEscapeLayer(instance) {
  const layersArr = [...globalThis.bitsEscapeLayers];
  const topMostLayer = layersArr.findLast(([_, { current: behaviorType }]) => behaviorType === "close" || behaviorType === "ignore");
  if (topMostLayer) return topMostLayer[0] === instance;
  const [firstLayerNode] = layersArr[0];
  return firstLayerNode === instance;
}
function Escape_layer($$payload, $$props) {
  push();
  let {
    escapeKeydownBehavior = "close",
    onEscapeKeydown = noop,
    children,
    enabled
  } = $$props;
  useEscapeLayer({
    escapeKeydownBehavior: box.with(() => escapeKeydownBehavior),
    onEscapeKeydown: box.with(() => onEscapeKeydown),
    enabled: box.with(() => enabled)
  });
  children?.($$payload);
  $$payload.out += `<!---->`;
  pop();
}
const focusStack = box([]);
function createFocusScopeStack() {
  return {
    add(focusScope) {
      const activeFocusScope = focusStack.current[0];
      if (activeFocusScope && focusScope.id !== activeFocusScope.id) {
        activeFocusScope.pause();
      }
      focusStack.current = removeFromFocusScopeArray(focusStack.current, focusScope);
      focusStack.current.unshift(focusScope);
    },
    remove(focusScope) {
      focusStack.current = removeFromFocusScopeArray(focusStack.current, focusScope);
      focusStack.current[0]?.resume();
    },
    get current() {
      return focusStack.current;
    }
  };
}
function createFocusScopeAPI() {
  let paused = false;
  let isHandlingFocus = false;
  return {
    id: useId(),
    get paused() {
      return paused;
    },
    get isHandlingFocus() {
      return isHandlingFocus;
    },
    set isHandlingFocus(value) {
      isHandlingFocus = value;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    }
  };
}
function removeFromFocusScopeArray(arr, item) {
  return [...arr].filter((i) => i.id !== item.id);
}
function removeLinks(items) {
  return items.filter((item) => item.tagName !== "A");
}
function focus(element, { select = false } = {}) {
  if (!(element && element.focus))
    return;
  if (document.activeElement === element)
    return;
  const previouslyFocusedElement = document.activeElement;
  element.focus({ preventScroll: true });
  if (element !== previouslyFocusedElement && isSelectableInput(element) && select) {
    element.select();
  }
}
function focusFirst(candidates, { select = false } = {}) {
  const previouslyFocusedElement = document.activeElement;
  for (const candidate of candidates) {
    focus(candidate, { select });
    if (document.activeElement !== previouslyFocusedElement) {
      return true;
    }
  }
}
function findVisible(elements, container) {
  for (const element of elements) {
    if (!isElementHidden(element, container))
      return element;
  }
}
function getTabbableCandidates(container) {
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    acceptNode: (node) => {
      const isHiddenInput3 = node.tagName === "INPUT" && node.type === "hidden";
      if (node.disabled || node.hidden || isHiddenInput3)
        return NodeFilter.FILTER_SKIP;
      return node.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  while (walker.nextNode())
    nodes.push(walker.currentNode);
  return nodes;
}
function getTabbableEdges(container) {
  const candidates = getTabbableCandidates(container);
  const first = findVisible(candidates, container);
  const last = findVisible(candidates.reverse(), container);
  return [first, last];
}
/*!
* tabbable 6.2.0
* @license MIT, https://github.com/focus-trap/tabbable/blob/master/LICENSE
*/
var candidateSelectors = ["input:not([inert])", "select:not([inert])", "textarea:not([inert])", "a[href]:not([inert])", "button:not([inert])", "[tabindex]:not(slot):not([inert])", "audio[controls]:not([inert])", "video[controls]:not([inert])", '[contenteditable]:not([contenteditable="false"]):not([inert])', "details>summary:first-of-type:not([inert])", "details:not([inert])"];
var candidateSelector = /* @__PURE__ */ candidateSelectors.join(",");
var NoElement = typeof Element === "undefined";
var matches = NoElement ? function() {
} : Element.prototype.matches || Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
var getRootNode = !NoElement && Element.prototype.getRootNode ? function(element) {
  var _element$getRootNode;
  return element === null || element === void 0 ? void 0 : (_element$getRootNode = element.getRootNode) === null || _element$getRootNode === void 0 ? void 0 : _element$getRootNode.call(element);
} : function(element) {
  return element === null || element === void 0 ? void 0 : element.ownerDocument;
};
var isInert = function isInert2(node, lookUp) {
  var _node$getAttribute;
  if (lookUp === void 0) {
    lookUp = true;
  }
  var inertAtt = node === null || node === void 0 ? void 0 : (_node$getAttribute = node.getAttribute) === null || _node$getAttribute === void 0 ? void 0 : _node$getAttribute.call(node, "inert");
  var inert = inertAtt === "" || inertAtt === "true";
  var result = inert || lookUp && node && isInert2(node.parentNode);
  return result;
};
var isContentEditable = function isContentEditable2(node) {
  var _node$getAttribute2;
  var attValue = node === null || node === void 0 ? void 0 : (_node$getAttribute2 = node.getAttribute) === null || _node$getAttribute2 === void 0 ? void 0 : _node$getAttribute2.call(node, "contenteditable");
  return attValue === "" || attValue === "true";
};
var getCandidates = function getCandidates2(el, includeContainer, filter) {
  if (isInert(el)) {
    return [];
  }
  var candidates = Array.prototype.slice.apply(el.querySelectorAll(candidateSelector));
  if (includeContainer && matches.call(el, candidateSelector)) {
    candidates.unshift(el);
  }
  candidates = candidates.filter(filter);
  return candidates;
};
var getCandidatesIteratively = function getCandidatesIteratively2(elements, includeContainer, options) {
  var candidates = [];
  var elementsToCheck = Array.from(elements);
  while (elementsToCheck.length) {
    var element = elementsToCheck.shift();
    if (isInert(element, false)) {
      continue;
    }
    if (element.tagName === "SLOT") {
      var assigned = element.assignedElements();
      var content = assigned.length ? assigned : element.children;
      var nestedCandidates = getCandidatesIteratively2(content, true, options);
      if (options.flatten) {
        candidates.push.apply(candidates, nestedCandidates);
      } else {
        candidates.push({
          scopeParent: element,
          candidates: nestedCandidates
        });
      }
    } else {
      var validCandidate = matches.call(element, candidateSelector);
      if (validCandidate && options.filter(element) && (includeContainer || !elements.includes(element))) {
        candidates.push(element);
      }
      var shadowRoot = element.shadowRoot || // check for an undisclosed shadow
      typeof options.getShadowRoot === "function" && options.getShadowRoot(element);
      var validShadowRoot = !isInert(shadowRoot, false) && (!options.shadowRootFilter || options.shadowRootFilter(element));
      if (shadowRoot && validShadowRoot) {
        var _nestedCandidates = getCandidatesIteratively2(shadowRoot === true ? element.children : shadowRoot.children, true, options);
        if (options.flatten) {
          candidates.push.apply(candidates, _nestedCandidates);
        } else {
          candidates.push({
            scopeParent: element,
            candidates: _nestedCandidates
          });
        }
      } else {
        elementsToCheck.unshift.apply(elementsToCheck, element.children);
      }
    }
  }
  return candidates;
};
var hasTabIndex = function hasTabIndex2(node) {
  return !isNaN(parseInt(node.getAttribute("tabindex"), 10));
};
var getTabIndex = function getTabIndex2(node) {
  if (!node) {
    throw new Error("No node provided");
  }
  if (node.tabIndex < 0) {
    if ((/^(AUDIO|VIDEO|DETAILS)$/.test(node.tagName) || isContentEditable(node)) && !hasTabIndex(node)) {
      return 0;
    }
  }
  return node.tabIndex;
};
var getSortOrderTabIndex = function getSortOrderTabIndex2(node, isScope) {
  var tabIndex = getTabIndex(node);
  if (tabIndex < 0 && isScope && !hasTabIndex(node)) {
    return 0;
  }
  return tabIndex;
};
var sortOrderedTabbables = function sortOrderedTabbables2(a, b) {
  return a.tabIndex === b.tabIndex ? a.documentOrder - b.documentOrder : a.tabIndex - b.tabIndex;
};
var isInput = function isInput2(node) {
  return node.tagName === "INPUT";
};
var isHiddenInput = function isHiddenInput2(node) {
  return isInput(node) && node.type === "hidden";
};
var isDetailsWithSummary = function isDetailsWithSummary2(node) {
  var r = node.tagName === "DETAILS" && Array.prototype.slice.apply(node.children).some(function(child) {
    return child.tagName === "SUMMARY";
  });
  return r;
};
var getCheckedRadio = function getCheckedRadio2(nodes, form) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].checked && nodes[i].form === form) {
      return nodes[i];
    }
  }
};
var isTabbableRadio = function isTabbableRadio2(node) {
  if (!node.name) {
    return true;
  }
  var radioScope = node.form || getRootNode(node);
  var queryRadios = function queryRadios2(name) {
    return radioScope.querySelectorAll('input[type="radio"][name="' + name + '"]');
  };
  var radioSet;
  if (typeof window !== "undefined" && typeof window.CSS !== "undefined" && typeof window.CSS.escape === "function") {
    radioSet = queryRadios(window.CSS.escape(node.name));
  } else {
    try {
      radioSet = queryRadios(node.name);
    } catch (err) {
      console.error("Looks like you have a radio button with a name attribute containing invalid CSS selector characters and need the CSS.escape polyfill: %s", err.message);
      return false;
    }
  }
  var checked = getCheckedRadio(radioSet, node.form);
  return !checked || checked === node;
};
var isRadio = function isRadio2(node) {
  return isInput(node) && node.type === "radio";
};
var isNonTabbableRadio = function isNonTabbableRadio2(node) {
  return isRadio(node) && !isTabbableRadio(node);
};
var isNodeAttached = function isNodeAttached2(node) {
  var _nodeRoot;
  var nodeRoot = node && getRootNode(node);
  var nodeRootHost = (_nodeRoot = nodeRoot) === null || _nodeRoot === void 0 ? void 0 : _nodeRoot.host;
  var attached = false;
  if (nodeRoot && nodeRoot !== node) {
    var _nodeRootHost, _nodeRootHost$ownerDo, _node$ownerDocument;
    attached = !!((_nodeRootHost = nodeRootHost) !== null && _nodeRootHost !== void 0 && (_nodeRootHost$ownerDo = _nodeRootHost.ownerDocument) !== null && _nodeRootHost$ownerDo !== void 0 && _nodeRootHost$ownerDo.contains(nodeRootHost) || node !== null && node !== void 0 && (_node$ownerDocument = node.ownerDocument) !== null && _node$ownerDocument !== void 0 && _node$ownerDocument.contains(node));
    while (!attached && nodeRootHost) {
      var _nodeRoot2, _nodeRootHost2, _nodeRootHost2$ownerD;
      nodeRoot = getRootNode(nodeRootHost);
      nodeRootHost = (_nodeRoot2 = nodeRoot) === null || _nodeRoot2 === void 0 ? void 0 : _nodeRoot2.host;
      attached = !!((_nodeRootHost2 = nodeRootHost) !== null && _nodeRootHost2 !== void 0 && (_nodeRootHost2$ownerD = _nodeRootHost2.ownerDocument) !== null && _nodeRootHost2$ownerD !== void 0 && _nodeRootHost2$ownerD.contains(nodeRootHost));
    }
  }
  return attached;
};
var isZeroArea = function isZeroArea2(node) {
  var _node$getBoundingClie = node.getBoundingClientRect(), width = _node$getBoundingClie.width, height = _node$getBoundingClie.height;
  return width === 0 && height === 0;
};
var isHidden = function isHidden2(node, _ref) {
  var displayCheck = _ref.displayCheck, getShadowRoot = _ref.getShadowRoot;
  if (getComputedStyle(node).visibility === "hidden") {
    return true;
  }
  var isDirectSummary = matches.call(node, "details>summary:first-of-type");
  var nodeUnderDetails = isDirectSummary ? node.parentElement : node;
  if (matches.call(nodeUnderDetails, "details:not([open]) *")) {
    return true;
  }
  if (!displayCheck || displayCheck === "full" || displayCheck === "legacy-full") {
    if (typeof getShadowRoot === "function") {
      var originalNode = node;
      while (node) {
        var parentElement = node.parentElement;
        var rootNode = getRootNode(node);
        if (parentElement && !parentElement.shadowRoot && getShadowRoot(parentElement) === true) {
          return isZeroArea(node);
        } else if (node.assignedSlot) {
          node = node.assignedSlot;
        } else if (!parentElement && rootNode !== node.ownerDocument) {
          node = rootNode.host;
        } else {
          node = parentElement;
        }
      }
      node = originalNode;
    }
    if (isNodeAttached(node)) {
      return !node.getClientRects().length;
    }
    if (displayCheck !== "legacy-full") {
      return true;
    }
  } else if (displayCheck === "non-zero-area") {
    return isZeroArea(node);
  }
  return false;
};
var isDisabledFromFieldset = function isDisabledFromFieldset2(node) {
  if (/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(node.tagName)) {
    var parentNode = node.parentElement;
    while (parentNode) {
      if (parentNode.tagName === "FIELDSET" && parentNode.disabled) {
        for (var i = 0; i < parentNode.children.length; i++) {
          var child = parentNode.children.item(i);
          if (child.tagName === "LEGEND") {
            return matches.call(parentNode, "fieldset[disabled] *") ? true : !child.contains(node);
          }
        }
        return true;
      }
      parentNode = parentNode.parentElement;
    }
  }
  return false;
};
var isNodeMatchingSelectorFocusable = function isNodeMatchingSelectorFocusable2(options, node) {
  if (node.disabled || // we must do an inert look up to filter out any elements inside an inert ancestor
  //  because we're limited in the type of selectors we can use in JSDom (see related
  //  note related to `candidateSelectors`)
  isInert(node) || isHiddenInput(node) || isHidden(node, options) || // For a details element with a summary, the summary element gets the focus
  isDetailsWithSummary(node) || isDisabledFromFieldset(node)) {
    return false;
  }
  return true;
};
var isNodeMatchingSelectorTabbable = function isNodeMatchingSelectorTabbable2(options, node) {
  if (isNonTabbableRadio(node) || getTabIndex(node) < 0 || !isNodeMatchingSelectorFocusable(options, node)) {
    return false;
  }
  return true;
};
var isValidShadowRootTabbable = function isValidShadowRootTabbable2(shadowHostNode) {
  var tabIndex = parseInt(shadowHostNode.getAttribute("tabindex"), 10);
  if (isNaN(tabIndex) || tabIndex >= 0) {
    return true;
  }
  return false;
};
var sortByOrder = function sortByOrder2(candidates) {
  var regularTabbables = [];
  var orderedTabbables = [];
  candidates.forEach(function(item, i) {
    var isScope = !!item.scopeParent;
    var element = isScope ? item.scopeParent : item;
    var candidateTabindex = getSortOrderTabIndex(element, isScope);
    var elements = isScope ? sortByOrder2(item.candidates) : element;
    if (candidateTabindex === 0) {
      isScope ? regularTabbables.push.apply(regularTabbables, elements) : regularTabbables.push(element);
    } else {
      orderedTabbables.push({
        documentOrder: i,
        tabIndex: candidateTabindex,
        item,
        isScope,
        content: elements
      });
    }
  });
  return orderedTabbables.sort(sortOrderedTabbables).reduce(function(acc, sortable) {
    sortable.isScope ? acc.push.apply(acc, sortable.content) : acc.push(sortable.content);
    return acc;
  }, []).concat(regularTabbables);
};
var tabbable = function tabbable2(container, options) {
  options = options || {};
  var candidates;
  if (options.getShadowRoot) {
    candidates = getCandidatesIteratively([container], options.includeContainer, {
      filter: isNodeMatchingSelectorTabbable.bind(null, options),
      flatten: false,
      getShadowRoot: options.getShadowRoot,
      shadowRootFilter: isValidShadowRootTabbable
    });
  } else {
    candidates = getCandidates(container, options.includeContainer, isNodeMatchingSelectorTabbable.bind(null, options));
  }
  return sortByOrder(candidates);
};
var focusable = function focusable2(container, options) {
  options = options || {};
  var candidates;
  if (options.getShadowRoot) {
    candidates = getCandidatesIteratively([container], options.includeContainer, {
      filter: isNodeMatchingSelectorFocusable.bind(null, options),
      flatten: true,
      getShadowRoot: options.getShadowRoot
    });
  } else {
    candidates = getCandidates(container, options.includeContainer, isNodeMatchingSelectorFocusable.bind(null, options));
  }
  return candidates;
};
var isTabbable = function isTabbable2(node, options) {
  options = options || {};
  if (!node) {
    throw new Error("No node provided");
  }
  if (matches.call(node, candidateSelector) === false) {
    return false;
  }
  return isNodeMatchingSelectorTabbable(options, node);
};
var focusableCandidateSelector = /* @__PURE__ */ candidateSelectors.concat("iframe").join(",");
var isFocusable = function isFocusable2(node, options) {
  options = options || {};
  if (!node) {
    throw new Error("No node provided");
  }
  if (matches.call(node, focusableCandidateSelector) === false) {
    return false;
  }
  return isNodeMatchingSelectorFocusable(options, node);
};
const AutoFocusOnMountEvent = new CustomEventDispatcher("focusScope.autoFocusOnMount", { bubbles: false, cancelable: true });
const AutoFocusOnDestroyEvent = new CustomEventDispatcher("focusScope.autoFocusOnDestroy", { bubbles: false, cancelable: true });
const FocusScopeContext = new Context("FocusScope");
function useFocusScope({
  id,
  loop,
  enabled,
  onOpenAutoFocus,
  onCloseAutoFocus,
  forceMount
}) {
  const focusScopeStack = createFocusScopeStack();
  const focusScope = createFocusScopeAPI();
  const ref = box(null);
  const ctx = FocusScopeContext.getOr({ ignoreCloseAutoFocus: false });
  let lastFocusedElement = null;
  useRefById({ id, ref, deps: () => enabled.current });
  function manageFocus(event) {
    if (focusScope.paused || !ref.current || focusScope.isHandlingFocus) return;
    focusScope.isHandlingFocus = true;
    try {
      const target = event.target;
      if (!isHTMLElement$1(target)) return;
      const isWithinActiveScope = ref.current.contains(target);
      if (event.type === "focusin") {
        if (isWithinActiveScope) {
          lastFocusedElement = target;
        } else {
          if (ctx.ignoreCloseAutoFocus) return;
          focus(lastFocusedElement, { select: true });
        }
      } else if (event.type === "focusout") {
        if (!isWithinActiveScope && !ctx.ignoreCloseAutoFocus) {
          focus(lastFocusedElement, { select: true });
        }
      }
    } finally {
      focusScope.isHandlingFocus = false;
    }
  }
  function handleMutations(_) {
    const lastFocusedElementExists = ref.current?.contains(lastFocusedElement);
    if (!lastFocusedElementExists && ref.current) {
      focus(ref.current);
    }
  }
  watch([() => ref.current, () => enabled.current], ([container, enabled2]) => {
    if (!container || !enabled2) return;
    const removeEvents = executeCallbacks(on(document, "focusin", manageFocus), on(document, "focusout", manageFocus));
    const mutationObserver = new MutationObserver(handleMutations);
    mutationObserver.observe(container, { childList: true, subtree: true });
    return () => {
      removeEvents();
      mutationObserver.disconnect();
    };
  });
  watch([() => forceMount.current, () => ref.current], ([forceMount2, container]) => {
    if (forceMount2) return;
    const prevFocusedElement = document.activeElement;
    handleOpen(container, prevFocusedElement);
    return () => {
      if (!container) return;
      handleClose(prevFocusedElement);
    };
  });
  watch(
    [
      () => forceMount.current,
      () => ref.current,
      () => enabled.current
    ],
    ([forceMount2, container]) => {
      if (!forceMount2) return;
      const prevFocusedElement = document.activeElement;
      handleOpen(container, prevFocusedElement);
      return () => {
        if (!container) return;
        handleClose(prevFocusedElement);
      };
    }
  );
  function handleOpen(container, prevFocusedElement) {
    if (!container) container = document.getElementById(id.current);
    if (!container || !enabled.current) return;
    focusScopeStack.add(focusScope);
    const hasFocusedCandidate = container.contains(prevFocusedElement);
    if (!hasFocusedCandidate) {
      const mountEvent = AutoFocusOnMountEvent.createEvent();
      onOpenAutoFocus.current(mountEvent);
      if (!mountEvent.defaultPrevented) {
        afterTick(() => {
          if (!container) return;
          focusFirst(removeLinks(getTabbableCandidates(container)), { select: true });
          if (document.activeElement === prevFocusedElement) {
            focus(container);
          }
        });
      }
    }
  }
  function handleClose(prevFocusedElement) {
    const destroyEvent = AutoFocusOnDestroyEvent.createEvent();
    onCloseAutoFocus.current(destroyEvent);
    const shouldIgnore = ctx.ignoreCloseAutoFocus;
    afterSleep(0, () => {
      if (!destroyEvent.defaultPrevented && prevFocusedElement && !shouldIgnore) {
        focus(isTabbable(prevFocusedElement) ? prevFocusedElement : document.body, { select: true });
      }
      focusScopeStack.remove(focusScope);
    });
  }
  function handleKeydown(e) {
    if (!enabled.current) return;
    if (!loop.current && !enabled.current) return;
    if (focusScope.paused) return;
    const isTabKey = e.key === TAB && !e.ctrlKey && !e.altKey && !e.metaKey;
    const focusedElement = document.activeElement;
    if (!(isTabKey && focusedElement)) return;
    const container = ref.current;
    if (!container) return;
    const [first, last] = getTabbableEdges(container);
    const hasTabbableElementsInside = first && last;
    if (!hasTabbableElementsInside) {
      if (focusedElement === container) {
        e.preventDefault();
      }
    } else {
      if (!e.shiftKey && focusedElement === last) {
        e.preventDefault();
        if (loop.current) focus(first, { select: true });
      } else if (e.shiftKey && focusedElement === first) {
        e.preventDefault();
        if (loop.current) focus(last, { select: true });
      }
    }
  }
  const props = (() => ({
    id: id.current,
    tabindex: -1,
    onkeydown: handleKeydown
  }))();
  return {
    get props() {
      return props;
    }
  };
}
function Focus_scope($$payload, $$props) {
  push();
  let {
    id,
    trapFocus = false,
    loop = false,
    onCloseAutoFocus = noop,
    onOpenAutoFocus = noop,
    focusScope,
    forceMount = false
  } = $$props;
  const focusScopeState = useFocusScope({
    enabled: box.with(() => trapFocus),
    loop: box.with(() => loop),
    onCloseAutoFocus: box.with(() => onCloseAutoFocus),
    onOpenAutoFocus: box.with(() => onOpenAutoFocus),
    id: box.with(() => id),
    forceMount: box.with(() => forceMount)
  });
  focusScope?.($$payload, { props: focusScopeState.props });
  $$payload.out += `<!---->`;
  pop();
}
globalThis.bitsTextSelectionLayers ??= /* @__PURE__ */ new Map();
class TextSelectionLayerState {
  opts;
  #unsubSelectionLock = noop;
  #ref = box(null);
  constructor(opts) {
    this.opts = opts;
    useRefById({
      id: opts.id,
      ref: this.#ref,
      deps: () => this.opts.enabled.current
    });
    let unsubEvents = noop;
    watch(() => this.opts.enabled.current, (isEnabled) => {
      if (isEnabled) {
        globalThis.bitsTextSelectionLayers.set(this, this.opts.enabled);
        unsubEvents();
        unsubEvents = this.#addEventListeners();
      }
      return () => {
        unsubEvents();
        this.#resetSelectionLock();
        globalThis.bitsTextSelectionLayers.delete(this);
      };
    });
  }
  #addEventListeners() {
    return executeCallbacks(on(document, "pointerdown", this.#pointerdown), on(document, "pointerup", composeHandlers(this.#resetSelectionLock, this.opts.onPointerUp.current)));
  }
  #pointerdown = (e) => {
    const node = this.#ref.current;
    const target = e.target;
    if (!isHTMLElement$1(node) || !isHTMLElement$1(target) || !this.opts.enabled.current) return;
    if (!isHighestLayer(this) || !isOrContainsTarget(node, target)) return;
    this.opts.onPointerDown.current(e);
    if (e.defaultPrevented) return;
    this.#unsubSelectionLock = preventTextSelectionOverflow(node);
  };
  #resetSelectionLock = () => {
    this.#unsubSelectionLock();
    this.#unsubSelectionLock = noop;
  };
}
function useTextSelectionLayer(props) {
  return new TextSelectionLayerState(props);
}
const getUserSelect = (node) => node.style.userSelect || node.style.webkitUserSelect;
function preventTextSelectionOverflow(node) {
  const body = document.body;
  const originalBodyUserSelect = getUserSelect(body);
  const originalNodeUserSelect = getUserSelect(node);
  setUserSelect(body, "none");
  setUserSelect(node, "text");
  return () => {
    setUserSelect(body, originalBodyUserSelect);
    setUserSelect(node, originalNodeUserSelect);
  };
}
function setUserSelect(node, value) {
  node.style.userSelect = value;
  node.style.webkitUserSelect = value;
}
function isHighestLayer(instance) {
  const layersArr = [...globalThis.bitsTextSelectionLayers];
  if (!layersArr.length) return false;
  const highestLayer = layersArr.at(-1);
  if (!highestLayer) return false;
  return highestLayer[0] === instance;
}
function Text_selection_layer($$payload, $$props) {
  push();
  let {
    preventOverflowTextSelection = true,
    onPointerDown = noop,
    onPointerUp = noop,
    id,
    children,
    enabled
  } = $$props;
  useTextSelectionLayer({
    id: box.with(() => id),
    preventOverflowTextSelection: box.with(() => preventOverflowTextSelection),
    onPointerDown: box.with(() => onPointerDown),
    onPointerUp: box.with(() => onPointerUp),
    enabled: box.with(() => enabled)
  });
  children?.($$payload);
  $$payload.out += `<!---->`;
  pop();
}
function createSharedHook(factory) {
  let state = void 0;
  return (...args) => {
    return state;
  };
}
const useBodyLockStackCount = createSharedHook();
function useBodyScrollLock(initialState, restoreScrollDelay = () => null) {
  useId();
  useBodyLockStackCount();
  return;
}
function Scroll_lock($$payload, $$props) {
  push();
  let {
    preventScroll = true,
    restoreScrollDelay = null
  } = $$props;
  useBodyScrollLock(preventScroll, () => restoreScrollDelay);
  pop();
}
const AVATAR_ROOT_ATTR = "data-avatar-root";
const AVATAR_IMAGE_ATTR = "data-avatar-image";
const AVATAR_FALLBACK_ATTR = "data-avatar-fallback";
class AvatarRootState {
  opts;
  constructor(opts) {
    this.opts = opts;
    this.loadImage = this.loadImage.bind(this);
    useRefById(opts);
  }
  loadImage(src, crossorigin, referrerPolicy) {
    if (this.opts.loadingStatus.current === "loaded") return;
    let imageTimerId;
    const image = new Image();
    image.src = src;
    if (crossorigin !== void 0) image.crossOrigin = crossorigin;
    if (referrerPolicy) image.referrerPolicy = referrerPolicy;
    this.opts.loadingStatus.current = "loading";
    image.onload = () => {
      imageTimerId = window.setTimeout(
        () => {
          this.opts.loadingStatus.current = "loaded";
        },
        this.opts.delayMs.current
      );
    };
    image.onerror = () => {
      this.opts.loadingStatus.current = "error";
    };
    return () => {
      window.clearTimeout(imageTimerId);
    };
  }
  #props = once(() => ({
    id: this.opts.id.current,
    [AVATAR_ROOT_ATTR]: "",
    "data-status": this.opts.loadingStatus.current
  }));
  get props() {
    return this.#props();
  }
}
class AvatarImageState {
  opts;
  root;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
  }
  #props = once(() => ({
    id: this.opts.id.current,
    style: {
      display: this.root.opts.loadingStatus.current === "loaded" ? "block" : "none"
    },
    "data-status": this.root.opts.loadingStatus.current,
    [AVATAR_IMAGE_ATTR]: "",
    src: this.opts.src.current,
    crossorigin: this.opts.crossOrigin.current,
    referrerpolicy: this.opts.referrerPolicy.current
  }));
  get props() {
    return this.#props();
  }
}
class AvatarFallbackState {
  opts;
  root;
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    useRefById(opts);
  }
  #props = once(() => ({
    style: {
      display: this.root.opts.loadingStatus.current === "loaded" ? "none" : void 0
    },
    "data-status": this.root.opts.loadingStatus.current,
    [AVATAR_FALLBACK_ATTR]: ""
  }));
  get props() {
    return this.#props();
  }
}
const AvatarRootContext = new Context("Avatar.Root");
function useAvatarRoot(props) {
  return AvatarRootContext.set(new AvatarRootState(props));
}
function useAvatarImage(props) {
  return new AvatarImageState(props, AvatarRootContext.get());
}
function useAvatarFallback(props) {
  return new AvatarFallbackState(props, AvatarRootContext.get());
}
function Avatar($$payload, $$props) {
  push();
  let {
    delayMs = 0,
    loadingStatus = "loading",
    onLoadingStatusChange,
    child,
    children,
    id = useId(),
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const rootState = useAvatarRoot({
    delayMs: box.with(() => delayMs),
    loadingStatus: box.with(() => loadingStatus, (v) => {
      if (loadingStatus !== v) {
        loadingStatus = v;
        onLoadingStatusChange?.(v);
      }
    }),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, rootState.props);
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
  bind_props($$props, { loadingStatus, ref });
  pop();
}
function Avatar_image($$payload, $$props) {
  push();
  let {
    src,
    child,
    id = useId(),
    ref = null,
    crossorigin = void 0,
    referrerpolicy = void 0,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const imageState = useAvatarImage({
    src: box.with(() => src),
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v),
    crossOrigin: box.with(() => crossorigin),
    referrerPolicy: box.with(() => referrerpolicy)
  });
  const mergedProps = mergeProps(restProps, imageState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<img${spread_attributes({ ...mergedProps, src }, null)} onload="this.__e=event" onerror="this.__e=event">`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Avatar_fallback($$payload, $$props) {
  push();
  let {
    children,
    child,
    id = useId(),
    ref = null,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const fallbackState = useAvatarFallback({
    id: box.with(() => id),
    ref: box.with(() => ref, (v) => ref = v)
  });
  const mergedProps = mergeProps(restProps, fallbackState.props);
  if (child) {
    $$payload.out += "<!--[-->";
    child($$payload, { props: mergedProps });
    $$payload.out += `<!---->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<span${spread_attributes({ ...mergedProps }, null)}>`;
    children?.($$payload);
    $$payload.out += `<!----></span>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { ref });
  pop();
}
function Hidden_input($$payload, $$props) {
  push();
  let {
    value = void 0,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  const mergedProps = mergeProps(restProps, {
    "aria-hidden": "true",
    tabindex: -1,
    style: srOnlyStylesString
  });
  if (mergedProps.type === "checkbox") {
    $$payload.out += "<!--[-->";
    $$payload.out += `<input${spread_attributes({ ...mergedProps, value }, null)}>`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<input${spread_attributes({ value, ...mergedProps }, null)}>`;
  }
  $$payload.out += `<!--]-->`;
  bind_props($$props, { value });
  pop();
}
const sides = ["top", "right", "bottom", "left"];
const min = Math.min;
const max = Math.max;
const round = Math.round;
const createCoords = (v) => ({
  x: v,
  y: v
});
const oppositeSideMap = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom"
};
const oppositeAlignmentMap = {
  start: "end",
  end: "start"
};
function clamp(start, value, end) {
  return max(start, min(value, end));
}
function evaluate(value, param) {
  return typeof value === "function" ? value(param) : value;
}
function getSide(placement) {
  return placement.split("-")[0];
}
function getAlignment(placement) {
  return placement.split("-")[1];
}
function getOppositeAxis(axis) {
  return axis === "x" ? "y" : "x";
}
function getAxisLength(axis) {
  return axis === "y" ? "height" : "width";
}
function getSideAxis(placement) {
  return ["top", "bottom"].includes(getSide(placement)) ? "y" : "x";
}
function getAlignmentAxis(placement) {
  return getOppositeAxis(getSideAxis(placement));
}
function getAlignmentSides(placement, rects, rtl) {
  if (rtl === void 0) {
    rtl = false;
  }
  const alignment = getAlignment(placement);
  const alignmentAxis = getAlignmentAxis(placement);
  const length = getAxisLength(alignmentAxis);
  let mainAlignmentSide = alignmentAxis === "x" ? alignment === (rtl ? "end" : "start") ? "right" : "left" : alignment === "start" ? "bottom" : "top";
  if (rects.reference[length] > rects.floating[length]) {
    mainAlignmentSide = getOppositePlacement(mainAlignmentSide);
  }
  return [mainAlignmentSide, getOppositePlacement(mainAlignmentSide)];
}
function getExpandedPlacements(placement) {
  const oppositePlacement = getOppositePlacement(placement);
  return [getOppositeAlignmentPlacement(placement), oppositePlacement, getOppositeAlignmentPlacement(oppositePlacement)];
}
function getOppositeAlignmentPlacement(placement) {
  return placement.replace(/start|end/g, (alignment) => oppositeAlignmentMap[alignment]);
}
function getSideList(side, isStart, rtl) {
  const lr = ["left", "right"];
  const rl = ["right", "left"];
  const tb = ["top", "bottom"];
  const bt = ["bottom", "top"];
  switch (side) {
    case "top":
    case "bottom":
      if (rtl) return isStart ? rl : lr;
      return isStart ? lr : rl;
    case "left":
    case "right":
      return isStart ? tb : bt;
    default:
      return [];
  }
}
function getOppositeAxisPlacements(placement, flipAlignment, direction, rtl) {
  const alignment = getAlignment(placement);
  let list = getSideList(getSide(placement), direction === "start", rtl);
  if (alignment) {
    list = list.map((side) => side + "-" + alignment);
    if (flipAlignment) {
      list = list.concat(list.map(getOppositeAlignmentPlacement));
    }
  }
  return list;
}
function getOppositePlacement(placement) {
  return placement.replace(/left|right|bottom|top/g, (side) => oppositeSideMap[side]);
}
function expandPaddingObject(padding) {
  return {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    ...padding
  };
}
function getPaddingObject(padding) {
  return typeof padding !== "number" ? expandPaddingObject(padding) : {
    top: padding,
    right: padding,
    bottom: padding,
    left: padding
  };
}
function rectToClientRect(rect) {
  const {
    x,
    y,
    width,
    height
  } = rect;
  return {
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    x,
    y
  };
}
function computeCoordsFromPlacement(_ref, placement, rtl) {
  let {
    reference,
    floating
  } = _ref;
  const sideAxis = getSideAxis(placement);
  const alignmentAxis = getAlignmentAxis(placement);
  const alignLength = getAxisLength(alignmentAxis);
  const side = getSide(placement);
  const isVertical = sideAxis === "y";
  const commonX = reference.x + reference.width / 2 - floating.width / 2;
  const commonY = reference.y + reference.height / 2 - floating.height / 2;
  const commonAlign = reference[alignLength] / 2 - floating[alignLength] / 2;
  let coords;
  switch (side) {
    case "top":
      coords = {
        x: commonX,
        y: reference.y - floating.height
      };
      break;
    case "bottom":
      coords = {
        x: commonX,
        y: reference.y + reference.height
      };
      break;
    case "right":
      coords = {
        x: reference.x + reference.width,
        y: commonY
      };
      break;
    case "left":
      coords = {
        x: reference.x - floating.width,
        y: commonY
      };
      break;
    default:
      coords = {
        x: reference.x,
        y: reference.y
      };
  }
  switch (getAlignment(placement)) {
    case "start":
      coords[alignmentAxis] -= commonAlign * (rtl && isVertical ? -1 : 1);
      break;
    case "end":
      coords[alignmentAxis] += commonAlign * (rtl && isVertical ? -1 : 1);
      break;
  }
  return coords;
}
const computePosition$1 = async (reference, floating, config) => {
  const {
    placement = "bottom",
    strategy = "absolute",
    middleware = [],
    platform: platform2
  } = config;
  const validMiddleware = middleware.filter(Boolean);
  const rtl = await (platform2.isRTL == null ? void 0 : platform2.isRTL(floating));
  let rects = await platform2.getElementRects({
    reference,
    floating,
    strategy
  });
  let {
    x,
    y
  } = computeCoordsFromPlacement(rects, placement, rtl);
  let statefulPlacement = placement;
  let middlewareData = {};
  let resetCount = 0;
  for (let i = 0; i < validMiddleware.length; i++) {
    const {
      name,
      fn
    } = validMiddleware[i];
    const {
      x: nextX,
      y: nextY,
      data,
      reset
    } = await fn({
      x,
      y,
      initialPlacement: placement,
      placement: statefulPlacement,
      strategy,
      middlewareData,
      rects,
      platform: platform2,
      elements: {
        reference,
        floating
      }
    });
    x = nextX != null ? nextX : x;
    y = nextY != null ? nextY : y;
    middlewareData = {
      ...middlewareData,
      [name]: {
        ...middlewareData[name],
        ...data
      }
    };
    if (reset && resetCount <= 50) {
      resetCount++;
      if (typeof reset === "object") {
        if (reset.placement) {
          statefulPlacement = reset.placement;
        }
        if (reset.rects) {
          rects = reset.rects === true ? await platform2.getElementRects({
            reference,
            floating,
            strategy
          }) : reset.rects;
        }
        ({
          x,
          y
        } = computeCoordsFromPlacement(rects, statefulPlacement, rtl));
      }
      i = -1;
    }
  }
  return {
    x,
    y,
    placement: statefulPlacement,
    strategy,
    middlewareData
  };
};
async function detectOverflow(state, options) {
  var _await$platform$isEle;
  if (options === void 0) {
    options = {};
  }
  const {
    x,
    y,
    platform: platform2,
    rects,
    elements,
    strategy
  } = state;
  const {
    boundary = "clippingAncestors",
    rootBoundary = "viewport",
    elementContext = "floating",
    altBoundary = false,
    padding = 0
  } = evaluate(options, state);
  const paddingObject = getPaddingObject(padding);
  const altContext = elementContext === "floating" ? "reference" : "floating";
  const element = elements[altBoundary ? altContext : elementContext];
  const clippingClientRect = rectToClientRect(await platform2.getClippingRect({
    element: ((_await$platform$isEle = await (platform2.isElement == null ? void 0 : platform2.isElement(element))) != null ? _await$platform$isEle : true) ? element : element.contextElement || await (platform2.getDocumentElement == null ? void 0 : platform2.getDocumentElement(elements.floating)),
    boundary,
    rootBoundary,
    strategy
  }));
  const rect = elementContext === "floating" ? {
    x,
    y,
    width: rects.floating.width,
    height: rects.floating.height
  } : rects.reference;
  const offsetParent = await (platform2.getOffsetParent == null ? void 0 : platform2.getOffsetParent(elements.floating));
  const offsetScale = await (platform2.isElement == null ? void 0 : platform2.isElement(offsetParent)) ? await (platform2.getScale == null ? void 0 : platform2.getScale(offsetParent)) || {
    x: 1,
    y: 1
  } : {
    x: 1,
    y: 1
  };
  const elementClientRect = rectToClientRect(platform2.convertOffsetParentRelativeRectToViewportRelativeRect ? await platform2.convertOffsetParentRelativeRectToViewportRelativeRect({
    elements,
    rect,
    offsetParent,
    strategy
  }) : rect);
  return {
    top: (clippingClientRect.top - elementClientRect.top + paddingObject.top) / offsetScale.y,
    bottom: (elementClientRect.bottom - clippingClientRect.bottom + paddingObject.bottom) / offsetScale.y,
    left: (clippingClientRect.left - elementClientRect.left + paddingObject.left) / offsetScale.x,
    right: (elementClientRect.right - clippingClientRect.right + paddingObject.right) / offsetScale.x
  };
}
const arrow$1 = (options) => ({
  name: "arrow",
  options,
  async fn(state) {
    const {
      x,
      y,
      placement,
      rects,
      platform: platform2,
      elements,
      middlewareData
    } = state;
    const {
      element,
      padding = 0
    } = evaluate(options, state) || {};
    if (element == null) {
      return {};
    }
    const paddingObject = getPaddingObject(padding);
    const coords = {
      x,
      y
    };
    const axis = getAlignmentAxis(placement);
    const length = getAxisLength(axis);
    const arrowDimensions = await platform2.getDimensions(element);
    const isYAxis = axis === "y";
    const minProp = isYAxis ? "top" : "left";
    const maxProp = isYAxis ? "bottom" : "right";
    const clientProp = isYAxis ? "clientHeight" : "clientWidth";
    const endDiff = rects.reference[length] + rects.reference[axis] - coords[axis] - rects.floating[length];
    const startDiff = coords[axis] - rects.reference[axis];
    const arrowOffsetParent = await (platform2.getOffsetParent == null ? void 0 : platform2.getOffsetParent(element));
    let clientSize = arrowOffsetParent ? arrowOffsetParent[clientProp] : 0;
    if (!clientSize || !await (platform2.isElement == null ? void 0 : platform2.isElement(arrowOffsetParent))) {
      clientSize = elements.floating[clientProp] || rects.floating[length];
    }
    const centerToReference = endDiff / 2 - startDiff / 2;
    const largestPossiblePadding = clientSize / 2 - arrowDimensions[length] / 2 - 1;
    const minPadding = min(paddingObject[minProp], largestPossiblePadding);
    const maxPadding = min(paddingObject[maxProp], largestPossiblePadding);
    const min$1 = minPadding;
    const max2 = clientSize - arrowDimensions[length] - maxPadding;
    const center = clientSize / 2 - arrowDimensions[length] / 2 + centerToReference;
    const offset2 = clamp(min$1, center, max2);
    const shouldAddOffset = !middlewareData.arrow && getAlignment(placement) != null && center !== offset2 && rects.reference[length] / 2 - (center < min$1 ? minPadding : maxPadding) - arrowDimensions[length] / 2 < 0;
    const alignmentOffset = shouldAddOffset ? center < min$1 ? center - min$1 : center - max2 : 0;
    return {
      [axis]: coords[axis] + alignmentOffset,
      data: {
        [axis]: offset2,
        centerOffset: center - offset2 - alignmentOffset,
        ...shouldAddOffset && {
          alignmentOffset
        }
      },
      reset: shouldAddOffset
    };
  }
});
const flip$1 = function(options) {
  if (options === void 0) {
    options = {};
  }
  return {
    name: "flip",
    options,
    async fn(state) {
      var _middlewareData$arrow, _middlewareData$flip;
      const {
        placement,
        middlewareData,
        rects,
        initialPlacement,
        platform: platform2,
        elements
      } = state;
      const {
        mainAxis: checkMainAxis = true,
        crossAxis: checkCrossAxis = true,
        fallbackPlacements: specifiedFallbackPlacements,
        fallbackStrategy = "bestFit",
        fallbackAxisSideDirection = "none",
        flipAlignment = true,
        ...detectOverflowOptions
      } = evaluate(options, state);
      if ((_middlewareData$arrow = middlewareData.arrow) != null && _middlewareData$arrow.alignmentOffset) {
        return {};
      }
      const side = getSide(placement);
      const initialSideAxis = getSideAxis(initialPlacement);
      const isBasePlacement = getSide(initialPlacement) === initialPlacement;
      const rtl = await (platform2.isRTL == null ? void 0 : platform2.isRTL(elements.floating));
      const fallbackPlacements = specifiedFallbackPlacements || (isBasePlacement || !flipAlignment ? [getOppositePlacement(initialPlacement)] : getExpandedPlacements(initialPlacement));
      const hasFallbackAxisSideDirection = fallbackAxisSideDirection !== "none";
      if (!specifiedFallbackPlacements && hasFallbackAxisSideDirection) {
        fallbackPlacements.push(...getOppositeAxisPlacements(initialPlacement, flipAlignment, fallbackAxisSideDirection, rtl));
      }
      const placements = [initialPlacement, ...fallbackPlacements];
      const overflow = await detectOverflow(state, detectOverflowOptions);
      const overflows = [];
      let overflowsData = ((_middlewareData$flip = middlewareData.flip) == null ? void 0 : _middlewareData$flip.overflows) || [];
      if (checkMainAxis) {
        overflows.push(overflow[side]);
      }
      if (checkCrossAxis) {
        const sides2 = getAlignmentSides(placement, rects, rtl);
        overflows.push(overflow[sides2[0]], overflow[sides2[1]]);
      }
      overflowsData = [...overflowsData, {
        placement,
        overflows
      }];
      if (!overflows.every((side2) => side2 <= 0)) {
        var _middlewareData$flip2, _overflowsData$filter;
        const nextIndex = (((_middlewareData$flip2 = middlewareData.flip) == null ? void 0 : _middlewareData$flip2.index) || 0) + 1;
        const nextPlacement = placements[nextIndex];
        if (nextPlacement) {
          return {
            data: {
              index: nextIndex,
              overflows: overflowsData
            },
            reset: {
              placement: nextPlacement
            }
          };
        }
        let resetPlacement = (_overflowsData$filter = overflowsData.filter((d) => d.overflows[0] <= 0).sort((a, b) => a.overflows[1] - b.overflows[1])[0]) == null ? void 0 : _overflowsData$filter.placement;
        if (!resetPlacement) {
          switch (fallbackStrategy) {
            case "bestFit": {
              var _overflowsData$filter2;
              const placement2 = (_overflowsData$filter2 = overflowsData.filter((d) => {
                if (hasFallbackAxisSideDirection) {
                  const currentSideAxis = getSideAxis(d.placement);
                  return currentSideAxis === initialSideAxis || // Create a bias to the `y` side axis due to horizontal
                  // reading directions favoring greater width.
                  currentSideAxis === "y";
                }
                return true;
              }).map((d) => [d.placement, d.overflows.filter((overflow2) => overflow2 > 0).reduce((acc, overflow2) => acc + overflow2, 0)]).sort((a, b) => a[1] - b[1])[0]) == null ? void 0 : _overflowsData$filter2[0];
              if (placement2) {
                resetPlacement = placement2;
              }
              break;
            }
            case "initialPlacement":
              resetPlacement = initialPlacement;
              break;
          }
        }
        if (placement !== resetPlacement) {
          return {
            reset: {
              placement: resetPlacement
            }
          };
        }
      }
      return {};
    }
  };
};
function getSideOffsets(overflow, rect) {
  return {
    top: overflow.top - rect.height,
    right: overflow.right - rect.width,
    bottom: overflow.bottom - rect.height,
    left: overflow.left - rect.width
  };
}
function isAnySideFullyClipped(overflow) {
  return sides.some((side) => overflow[side] >= 0);
}
const hide$1 = function(options) {
  if (options === void 0) {
    options = {};
  }
  return {
    name: "hide",
    options,
    async fn(state) {
      const {
        rects
      } = state;
      const {
        strategy = "referenceHidden",
        ...detectOverflowOptions
      } = evaluate(options, state);
      switch (strategy) {
        case "referenceHidden": {
          const overflow = await detectOverflow(state, {
            ...detectOverflowOptions,
            elementContext: "reference"
          });
          const offsets = getSideOffsets(overflow, rects.reference);
          return {
            data: {
              referenceHiddenOffsets: offsets,
              referenceHidden: isAnySideFullyClipped(offsets)
            }
          };
        }
        case "escaped": {
          const overflow = await detectOverflow(state, {
            ...detectOverflowOptions,
            altBoundary: true
          });
          const offsets = getSideOffsets(overflow, rects.floating);
          return {
            data: {
              escapedOffsets: offsets,
              escaped: isAnySideFullyClipped(offsets)
            }
          };
        }
        default: {
          return {};
        }
      }
    }
  };
};
async function convertValueToCoords(state, options) {
  const {
    placement,
    platform: platform2,
    elements
  } = state;
  const rtl = await (platform2.isRTL == null ? void 0 : platform2.isRTL(elements.floating));
  const side = getSide(placement);
  const alignment = getAlignment(placement);
  const isVertical = getSideAxis(placement) === "y";
  const mainAxisMulti = ["left", "top"].includes(side) ? -1 : 1;
  const crossAxisMulti = rtl && isVertical ? -1 : 1;
  const rawValue = evaluate(options, state);
  let {
    mainAxis,
    crossAxis,
    alignmentAxis
  } = typeof rawValue === "number" ? {
    mainAxis: rawValue,
    crossAxis: 0,
    alignmentAxis: null
  } : {
    mainAxis: rawValue.mainAxis || 0,
    crossAxis: rawValue.crossAxis || 0,
    alignmentAxis: rawValue.alignmentAxis
  };
  if (alignment && typeof alignmentAxis === "number") {
    crossAxis = alignment === "end" ? alignmentAxis * -1 : alignmentAxis;
  }
  return isVertical ? {
    x: crossAxis * crossAxisMulti,
    y: mainAxis * mainAxisMulti
  } : {
    x: mainAxis * mainAxisMulti,
    y: crossAxis * crossAxisMulti
  };
}
const offset$1 = function(options) {
  if (options === void 0) {
    options = 0;
  }
  return {
    name: "offset",
    options,
    async fn(state) {
      var _middlewareData$offse, _middlewareData$arrow;
      const {
        x,
        y,
        placement,
        middlewareData
      } = state;
      const diffCoords = await convertValueToCoords(state, options);
      if (placement === ((_middlewareData$offse = middlewareData.offset) == null ? void 0 : _middlewareData$offse.placement) && (_middlewareData$arrow = middlewareData.arrow) != null && _middlewareData$arrow.alignmentOffset) {
        return {};
      }
      return {
        x: x + diffCoords.x,
        y: y + diffCoords.y,
        data: {
          ...diffCoords,
          placement
        }
      };
    }
  };
};
const shift$1 = function(options) {
  if (options === void 0) {
    options = {};
  }
  return {
    name: "shift",
    options,
    async fn(state) {
      const {
        x,
        y,
        placement
      } = state;
      const {
        mainAxis: checkMainAxis = true,
        crossAxis: checkCrossAxis = false,
        limiter = {
          fn: (_ref) => {
            let {
              x: x2,
              y: y2
            } = _ref;
            return {
              x: x2,
              y: y2
            };
          }
        },
        ...detectOverflowOptions
      } = evaluate(options, state);
      const coords = {
        x,
        y
      };
      const overflow = await detectOverflow(state, detectOverflowOptions);
      const crossAxis = getSideAxis(getSide(placement));
      const mainAxis = getOppositeAxis(crossAxis);
      let mainAxisCoord = coords[mainAxis];
      let crossAxisCoord = coords[crossAxis];
      if (checkMainAxis) {
        const minSide = mainAxis === "y" ? "top" : "left";
        const maxSide = mainAxis === "y" ? "bottom" : "right";
        const min2 = mainAxisCoord + overflow[minSide];
        const max2 = mainAxisCoord - overflow[maxSide];
        mainAxisCoord = clamp(min2, mainAxisCoord, max2);
      }
      if (checkCrossAxis) {
        const minSide = crossAxis === "y" ? "top" : "left";
        const maxSide = crossAxis === "y" ? "bottom" : "right";
        const min2 = crossAxisCoord + overflow[minSide];
        const max2 = crossAxisCoord - overflow[maxSide];
        crossAxisCoord = clamp(min2, crossAxisCoord, max2);
      }
      const limitedCoords = limiter.fn({
        ...state,
        [mainAxis]: mainAxisCoord,
        [crossAxis]: crossAxisCoord
      });
      return {
        ...limitedCoords,
        data: {
          x: limitedCoords.x - x,
          y: limitedCoords.y - y,
          enabled: {
            [mainAxis]: checkMainAxis,
            [crossAxis]: checkCrossAxis
          }
        }
      };
    }
  };
};
const limitShift$1 = function(options) {
  if (options === void 0) {
    options = {};
  }
  return {
    options,
    fn(state) {
      const {
        x,
        y,
        placement,
        rects,
        middlewareData
      } = state;
      const {
        offset: offset2 = 0,
        mainAxis: checkMainAxis = true,
        crossAxis: checkCrossAxis = true
      } = evaluate(options, state);
      const coords = {
        x,
        y
      };
      const crossAxis = getSideAxis(placement);
      const mainAxis = getOppositeAxis(crossAxis);
      let mainAxisCoord = coords[mainAxis];
      let crossAxisCoord = coords[crossAxis];
      const rawOffset = evaluate(offset2, state);
      const computedOffset = typeof rawOffset === "number" ? {
        mainAxis: rawOffset,
        crossAxis: 0
      } : {
        mainAxis: 0,
        crossAxis: 0,
        ...rawOffset
      };
      if (checkMainAxis) {
        const len = mainAxis === "y" ? "height" : "width";
        const limitMin = rects.reference[mainAxis] - rects.floating[len] + computedOffset.mainAxis;
        const limitMax = rects.reference[mainAxis] + rects.reference[len] - computedOffset.mainAxis;
        if (mainAxisCoord < limitMin) {
          mainAxisCoord = limitMin;
        } else if (mainAxisCoord > limitMax) {
          mainAxisCoord = limitMax;
        }
      }
      if (checkCrossAxis) {
        var _middlewareData$offse, _middlewareData$offse2;
        const len = mainAxis === "y" ? "width" : "height";
        const isOriginSide = ["top", "left"].includes(getSide(placement));
        const limitMin = rects.reference[crossAxis] - rects.floating[len] + (isOriginSide ? ((_middlewareData$offse = middlewareData.offset) == null ? void 0 : _middlewareData$offse[crossAxis]) || 0 : 0) + (isOriginSide ? 0 : computedOffset.crossAxis);
        const limitMax = rects.reference[crossAxis] + rects.reference[len] + (isOriginSide ? 0 : ((_middlewareData$offse2 = middlewareData.offset) == null ? void 0 : _middlewareData$offse2[crossAxis]) || 0) - (isOriginSide ? computedOffset.crossAxis : 0);
        if (crossAxisCoord < limitMin) {
          crossAxisCoord = limitMin;
        } else if (crossAxisCoord > limitMax) {
          crossAxisCoord = limitMax;
        }
      }
      return {
        [mainAxis]: mainAxisCoord,
        [crossAxis]: crossAxisCoord
      };
    }
  };
};
const size$1 = function(options) {
  if (options === void 0) {
    options = {};
  }
  return {
    name: "size",
    options,
    async fn(state) {
      var _state$middlewareData, _state$middlewareData2;
      const {
        placement,
        rects,
        platform: platform2,
        elements
      } = state;
      const {
        apply = () => {
        },
        ...detectOverflowOptions
      } = evaluate(options, state);
      const overflow = await detectOverflow(state, detectOverflowOptions);
      const side = getSide(placement);
      const alignment = getAlignment(placement);
      const isYAxis = getSideAxis(placement) === "y";
      const {
        width,
        height
      } = rects.floating;
      let heightSide;
      let widthSide;
      if (side === "top" || side === "bottom") {
        heightSide = side;
        widthSide = alignment === (await (platform2.isRTL == null ? void 0 : platform2.isRTL(elements.floating)) ? "start" : "end") ? "left" : "right";
      } else {
        widthSide = side;
        heightSide = alignment === "end" ? "top" : "bottom";
      }
      const maximumClippingHeight = height - overflow.top - overflow.bottom;
      const maximumClippingWidth = width - overflow.left - overflow.right;
      const overflowAvailableHeight = min(height - overflow[heightSide], maximumClippingHeight);
      const overflowAvailableWidth = min(width - overflow[widthSide], maximumClippingWidth);
      const noShift = !state.middlewareData.shift;
      let availableHeight = overflowAvailableHeight;
      let availableWidth = overflowAvailableWidth;
      if ((_state$middlewareData = state.middlewareData.shift) != null && _state$middlewareData.enabled.x) {
        availableWidth = maximumClippingWidth;
      }
      if ((_state$middlewareData2 = state.middlewareData.shift) != null && _state$middlewareData2.enabled.y) {
        availableHeight = maximumClippingHeight;
      }
      if (noShift && !alignment) {
        const xMin = max(overflow.left, 0);
        const xMax = max(overflow.right, 0);
        const yMin = max(overflow.top, 0);
        const yMax = max(overflow.bottom, 0);
        if (isYAxis) {
          availableWidth = width - 2 * (xMin !== 0 || xMax !== 0 ? xMin + xMax : max(overflow.left, overflow.right));
        } else {
          availableHeight = height - 2 * (yMin !== 0 || yMax !== 0 ? yMin + yMax : max(overflow.top, overflow.bottom));
        }
      }
      await apply({
        ...state,
        availableWidth,
        availableHeight
      });
      const nextDimensions = await platform2.getDimensions(elements.floating);
      if (width !== nextDimensions.width || height !== nextDimensions.height) {
        return {
          reset: {
            rects: true
          }
        };
      }
      return {};
    }
  };
};
function hasWindow() {
  return typeof window !== "undefined";
}
function getNodeName(node) {
  if (isNode(node)) {
    return (node.nodeName || "").toLowerCase();
  }
  return "#document";
}
function getWindow(node) {
  var _node$ownerDocument;
  return (node == null || (_node$ownerDocument = node.ownerDocument) == null ? void 0 : _node$ownerDocument.defaultView) || window;
}
function getDocumentElement(node) {
  var _ref;
  return (_ref = (isNode(node) ? node.ownerDocument : node.document) || window.document) == null ? void 0 : _ref.documentElement;
}
function isNode(value) {
  if (!hasWindow()) {
    return false;
  }
  return value instanceof Node || value instanceof getWindow(value).Node;
}
function isElement(value) {
  if (!hasWindow()) {
    return false;
  }
  return value instanceof Element || value instanceof getWindow(value).Element;
}
function isHTMLElement(value) {
  if (!hasWindow()) {
    return false;
  }
  return value instanceof HTMLElement || value instanceof getWindow(value).HTMLElement;
}
function isShadowRoot(value) {
  if (!hasWindow() || typeof ShadowRoot === "undefined") {
    return false;
  }
  return value instanceof ShadowRoot || value instanceof getWindow(value).ShadowRoot;
}
function isOverflowElement(element) {
  const {
    overflow,
    overflowX,
    overflowY,
    display
  } = getComputedStyle$1(element);
  return /auto|scroll|overlay|hidden|clip/.test(overflow + overflowY + overflowX) && !["inline", "contents"].includes(display);
}
function isTableElement(element) {
  return ["table", "td", "th"].includes(getNodeName(element));
}
function isTopLayer(element) {
  return [":popover-open", ":modal"].some((selector) => {
    try {
      return element.matches(selector);
    } catch (e) {
      return false;
    }
  });
}
function isContainingBlock(elementOrCss) {
  const webkit = isWebKit();
  const css = isElement(elementOrCss) ? getComputedStyle$1(elementOrCss) : elementOrCss;
  return ["transform", "translate", "scale", "rotate", "perspective"].some((value) => css[value] ? css[value] !== "none" : false) || (css.containerType ? css.containerType !== "normal" : false) || !webkit && (css.backdropFilter ? css.backdropFilter !== "none" : false) || !webkit && (css.filter ? css.filter !== "none" : false) || ["transform", "translate", "scale", "rotate", "perspective", "filter"].some((value) => (css.willChange || "").includes(value)) || ["paint", "layout", "strict", "content"].some((value) => (css.contain || "").includes(value));
}
function getContainingBlock(element) {
  let currentNode = getParentNode(element);
  while (isHTMLElement(currentNode) && !isLastTraversableNode(currentNode)) {
    if (isContainingBlock(currentNode)) {
      return currentNode;
    } else if (isTopLayer(currentNode)) {
      return null;
    }
    currentNode = getParentNode(currentNode);
  }
  return null;
}
function isWebKit() {
  if (typeof CSS === "undefined" || !CSS.supports) return false;
  return CSS.supports("-webkit-backdrop-filter", "none");
}
function isLastTraversableNode(node) {
  return ["html", "body", "#document"].includes(getNodeName(node));
}
function getComputedStyle$1(element) {
  return getWindow(element).getComputedStyle(element);
}
function getNodeScroll(element) {
  if (isElement(element)) {
    return {
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop
    };
  }
  return {
    scrollLeft: element.scrollX,
    scrollTop: element.scrollY
  };
}
function getParentNode(node) {
  if (getNodeName(node) === "html") {
    return node;
  }
  const result = (
    // Step into the shadow DOM of the parent of a slotted node.
    node.assignedSlot || // DOM Element detected.
    node.parentNode || // ShadowRoot detected.
    isShadowRoot(node) && node.host || // Fallback.
    getDocumentElement(node)
  );
  return isShadowRoot(result) ? result.host : result;
}
function getNearestOverflowAncestor(node) {
  const parentNode = getParentNode(node);
  if (isLastTraversableNode(parentNode)) {
    return node.ownerDocument ? node.ownerDocument.body : node.body;
  }
  if (isHTMLElement(parentNode) && isOverflowElement(parentNode)) {
    return parentNode;
  }
  return getNearestOverflowAncestor(parentNode);
}
function getOverflowAncestors(node, list, traverseIframes) {
  var _node$ownerDocument2;
  if (list === void 0) {
    list = [];
  }
  const scrollableAncestor = getNearestOverflowAncestor(node);
  const isBody = scrollableAncestor === ((_node$ownerDocument2 = node.ownerDocument) == null ? void 0 : _node$ownerDocument2.body);
  const win = getWindow(scrollableAncestor);
  if (isBody) {
    getFrameElement(win);
    return list.concat(win, win.visualViewport || [], isOverflowElement(scrollableAncestor) ? scrollableAncestor : [], []);
  }
  return list.concat(scrollableAncestor, getOverflowAncestors(scrollableAncestor, []));
}
function getFrameElement(win) {
  return win.parent && Object.getPrototypeOf(win.parent) ? win.frameElement : null;
}
function getCssDimensions(element) {
  const css = getComputedStyle$1(element);
  let width = parseFloat(css.width) || 0;
  let height = parseFloat(css.height) || 0;
  const hasOffset = isHTMLElement(element);
  const offsetWidth = hasOffset ? element.offsetWidth : width;
  const offsetHeight = hasOffset ? element.offsetHeight : height;
  const shouldFallback = round(width) !== offsetWidth || round(height) !== offsetHeight;
  if (shouldFallback) {
    width = offsetWidth;
    height = offsetHeight;
  }
  return {
    width,
    height,
    $: shouldFallback
  };
}
function unwrapElement(element) {
  return !isElement(element) ? element.contextElement : element;
}
function getScale(element) {
  const domElement = unwrapElement(element);
  if (!isHTMLElement(domElement)) {
    return createCoords(1);
  }
  const rect = domElement.getBoundingClientRect();
  const {
    width,
    height,
    $
  } = getCssDimensions(domElement);
  let x = ($ ? round(rect.width) : rect.width) / width;
  let y = ($ ? round(rect.height) : rect.height) / height;
  if (!x || !Number.isFinite(x)) {
    x = 1;
  }
  if (!y || !Number.isFinite(y)) {
    y = 1;
  }
  return {
    x,
    y
  };
}
const noOffsets = /* @__PURE__ */ createCoords(0);
function getVisualOffsets(element) {
  const win = getWindow(element);
  if (!isWebKit() || !win.visualViewport) {
    return noOffsets;
  }
  return {
    x: win.visualViewport.offsetLeft,
    y: win.visualViewport.offsetTop
  };
}
function shouldAddVisualOffsets(element, isFixed, floatingOffsetParent) {
  if (isFixed === void 0) {
    isFixed = false;
  }
  if (!floatingOffsetParent || isFixed && floatingOffsetParent !== getWindow(element)) {
    return false;
  }
  return isFixed;
}
function getBoundingClientRect(element, includeScale, isFixedStrategy, offsetParent) {
  if (includeScale === void 0) {
    includeScale = false;
  }
  if (isFixedStrategy === void 0) {
    isFixedStrategy = false;
  }
  const clientRect = element.getBoundingClientRect();
  const domElement = unwrapElement(element);
  let scale = createCoords(1);
  if (includeScale) {
    if (offsetParent) {
      if (isElement(offsetParent)) {
        scale = getScale(offsetParent);
      }
    } else {
      scale = getScale(element);
    }
  }
  const visualOffsets = shouldAddVisualOffsets(domElement, isFixedStrategy, offsetParent) ? getVisualOffsets(domElement) : createCoords(0);
  let x = (clientRect.left + visualOffsets.x) / scale.x;
  let y = (clientRect.top + visualOffsets.y) / scale.y;
  let width = clientRect.width / scale.x;
  let height = clientRect.height / scale.y;
  if (domElement) {
    const win = getWindow(domElement);
    const offsetWin = offsetParent && isElement(offsetParent) ? getWindow(offsetParent) : offsetParent;
    let currentWin = win;
    let currentIFrame = getFrameElement(currentWin);
    while (currentIFrame && offsetParent && offsetWin !== currentWin) {
      const iframeScale = getScale(currentIFrame);
      const iframeRect = currentIFrame.getBoundingClientRect();
      const css = getComputedStyle$1(currentIFrame);
      const left = iframeRect.left + (currentIFrame.clientLeft + parseFloat(css.paddingLeft)) * iframeScale.x;
      const top = iframeRect.top + (currentIFrame.clientTop + parseFloat(css.paddingTop)) * iframeScale.y;
      x *= iframeScale.x;
      y *= iframeScale.y;
      width *= iframeScale.x;
      height *= iframeScale.y;
      x += left;
      y += top;
      currentWin = getWindow(currentIFrame);
      currentIFrame = getFrameElement(currentWin);
    }
  }
  return rectToClientRect({
    width,
    height,
    x,
    y
  });
}
function getWindowScrollBarX(element, rect) {
  const leftScroll = getNodeScroll(element).scrollLeft;
  if (!rect) {
    return getBoundingClientRect(getDocumentElement(element)).left + leftScroll;
  }
  return rect.left + leftScroll;
}
function getHTMLOffset(documentElement, scroll, ignoreScrollbarX) {
  if (ignoreScrollbarX === void 0) {
    ignoreScrollbarX = false;
  }
  const htmlRect = documentElement.getBoundingClientRect();
  const x = htmlRect.left + scroll.scrollLeft - (ignoreScrollbarX ? 0 : (
    // RTL <body> scrollbar.
    getWindowScrollBarX(documentElement, htmlRect)
  ));
  const y = htmlRect.top + scroll.scrollTop;
  return {
    x,
    y
  };
}
function convertOffsetParentRelativeRectToViewportRelativeRect(_ref) {
  let {
    elements,
    rect,
    offsetParent,
    strategy
  } = _ref;
  const isFixed = strategy === "fixed";
  const documentElement = getDocumentElement(offsetParent);
  const topLayer = elements ? isTopLayer(elements.floating) : false;
  if (offsetParent === documentElement || topLayer && isFixed) {
    return rect;
  }
  let scroll = {
    scrollLeft: 0,
    scrollTop: 0
  };
  let scale = createCoords(1);
  const offsets = createCoords(0);
  const isOffsetParentAnElement = isHTMLElement(offsetParent);
  if (isOffsetParentAnElement || !isOffsetParentAnElement && !isFixed) {
    if (getNodeName(offsetParent) !== "body" || isOverflowElement(documentElement)) {
      scroll = getNodeScroll(offsetParent);
    }
    if (isHTMLElement(offsetParent)) {
      const offsetRect = getBoundingClientRect(offsetParent);
      scale = getScale(offsetParent);
      offsets.x = offsetRect.x + offsetParent.clientLeft;
      offsets.y = offsetRect.y + offsetParent.clientTop;
    }
  }
  const htmlOffset = documentElement && !isOffsetParentAnElement && !isFixed ? getHTMLOffset(documentElement, scroll, true) : createCoords(0);
  return {
    width: rect.width * scale.x,
    height: rect.height * scale.y,
    x: rect.x * scale.x - scroll.scrollLeft * scale.x + offsets.x + htmlOffset.x,
    y: rect.y * scale.y - scroll.scrollTop * scale.y + offsets.y + htmlOffset.y
  };
}
function getClientRects(element) {
  return Array.from(element.getClientRects());
}
function getDocumentRect(element) {
  const html = getDocumentElement(element);
  const scroll = getNodeScroll(element);
  const body = element.ownerDocument.body;
  const width = max(html.scrollWidth, html.clientWidth, body.scrollWidth, body.clientWidth);
  const height = max(html.scrollHeight, html.clientHeight, body.scrollHeight, body.clientHeight);
  let x = -scroll.scrollLeft + getWindowScrollBarX(element);
  const y = -scroll.scrollTop;
  if (getComputedStyle$1(body).direction === "rtl") {
    x += max(html.clientWidth, body.clientWidth) - width;
  }
  return {
    width,
    height,
    x,
    y
  };
}
function getViewportRect(element, strategy) {
  const win = getWindow(element);
  const html = getDocumentElement(element);
  const visualViewport = win.visualViewport;
  let width = html.clientWidth;
  let height = html.clientHeight;
  let x = 0;
  let y = 0;
  if (visualViewport) {
    width = visualViewport.width;
    height = visualViewport.height;
    const visualViewportBased = isWebKit();
    if (!visualViewportBased || visualViewportBased && strategy === "fixed") {
      x = visualViewport.offsetLeft;
      y = visualViewport.offsetTop;
    }
  }
  return {
    width,
    height,
    x,
    y
  };
}
function getInnerBoundingClientRect(element, strategy) {
  const clientRect = getBoundingClientRect(element, true, strategy === "fixed");
  const top = clientRect.top + element.clientTop;
  const left = clientRect.left + element.clientLeft;
  const scale = isHTMLElement(element) ? getScale(element) : createCoords(1);
  const width = element.clientWidth * scale.x;
  const height = element.clientHeight * scale.y;
  const x = left * scale.x;
  const y = top * scale.y;
  return {
    width,
    height,
    x,
    y
  };
}
function getClientRectFromClippingAncestor(element, clippingAncestor, strategy) {
  let rect;
  if (clippingAncestor === "viewport") {
    rect = getViewportRect(element, strategy);
  } else if (clippingAncestor === "document") {
    rect = getDocumentRect(getDocumentElement(element));
  } else if (isElement(clippingAncestor)) {
    rect = getInnerBoundingClientRect(clippingAncestor, strategy);
  } else {
    const visualOffsets = getVisualOffsets(element);
    rect = {
      x: clippingAncestor.x - visualOffsets.x,
      y: clippingAncestor.y - visualOffsets.y,
      width: clippingAncestor.width,
      height: clippingAncestor.height
    };
  }
  return rectToClientRect(rect);
}
function hasFixedPositionAncestor(element, stopNode) {
  const parentNode = getParentNode(element);
  if (parentNode === stopNode || !isElement(parentNode) || isLastTraversableNode(parentNode)) {
    return false;
  }
  return getComputedStyle$1(parentNode).position === "fixed" || hasFixedPositionAncestor(parentNode, stopNode);
}
function getClippingElementAncestors(element, cache) {
  const cachedResult = cache.get(element);
  if (cachedResult) {
    return cachedResult;
  }
  let result = getOverflowAncestors(element, []).filter((el) => isElement(el) && getNodeName(el) !== "body");
  let currentContainingBlockComputedStyle = null;
  const elementIsFixed = getComputedStyle$1(element).position === "fixed";
  let currentNode = elementIsFixed ? getParentNode(element) : element;
  while (isElement(currentNode) && !isLastTraversableNode(currentNode)) {
    const computedStyle = getComputedStyle$1(currentNode);
    const currentNodeIsContaining = isContainingBlock(currentNode);
    if (!currentNodeIsContaining && computedStyle.position === "fixed") {
      currentContainingBlockComputedStyle = null;
    }
    const shouldDropCurrentNode = elementIsFixed ? !currentNodeIsContaining && !currentContainingBlockComputedStyle : !currentNodeIsContaining && computedStyle.position === "static" && !!currentContainingBlockComputedStyle && ["absolute", "fixed"].includes(currentContainingBlockComputedStyle.position) || isOverflowElement(currentNode) && !currentNodeIsContaining && hasFixedPositionAncestor(element, currentNode);
    if (shouldDropCurrentNode) {
      result = result.filter((ancestor) => ancestor !== currentNode);
    } else {
      currentContainingBlockComputedStyle = computedStyle;
    }
    currentNode = getParentNode(currentNode);
  }
  cache.set(element, result);
  return result;
}
function getClippingRect(_ref) {
  let {
    element,
    boundary,
    rootBoundary,
    strategy
  } = _ref;
  const elementClippingAncestors = boundary === "clippingAncestors" ? isTopLayer(element) ? [] : getClippingElementAncestors(element, this._c) : [].concat(boundary);
  const clippingAncestors = [...elementClippingAncestors, rootBoundary];
  const firstClippingAncestor = clippingAncestors[0];
  const clippingRect = clippingAncestors.reduce((accRect, clippingAncestor) => {
    const rect = getClientRectFromClippingAncestor(element, clippingAncestor, strategy);
    accRect.top = max(rect.top, accRect.top);
    accRect.right = min(rect.right, accRect.right);
    accRect.bottom = min(rect.bottom, accRect.bottom);
    accRect.left = max(rect.left, accRect.left);
    return accRect;
  }, getClientRectFromClippingAncestor(element, firstClippingAncestor, strategy));
  return {
    width: clippingRect.right - clippingRect.left,
    height: clippingRect.bottom - clippingRect.top,
    x: clippingRect.left,
    y: clippingRect.top
  };
}
function getDimensions(element) {
  const {
    width,
    height
  } = getCssDimensions(element);
  return {
    width,
    height
  };
}
function getRectRelativeToOffsetParent(element, offsetParent, strategy) {
  const isOffsetParentAnElement = isHTMLElement(offsetParent);
  const documentElement = getDocumentElement(offsetParent);
  const isFixed = strategy === "fixed";
  const rect = getBoundingClientRect(element, true, isFixed, offsetParent);
  let scroll = {
    scrollLeft: 0,
    scrollTop: 0
  };
  const offsets = createCoords(0);
  if (isOffsetParentAnElement || !isOffsetParentAnElement && !isFixed) {
    if (getNodeName(offsetParent) !== "body" || isOverflowElement(documentElement)) {
      scroll = getNodeScroll(offsetParent);
    }
    if (isOffsetParentAnElement) {
      const offsetRect = getBoundingClientRect(offsetParent, true, isFixed, offsetParent);
      offsets.x = offsetRect.x + offsetParent.clientLeft;
      offsets.y = offsetRect.y + offsetParent.clientTop;
    } else if (documentElement) {
      offsets.x = getWindowScrollBarX(documentElement);
    }
  }
  const htmlOffset = documentElement && !isOffsetParentAnElement && !isFixed ? getHTMLOffset(documentElement, scroll) : createCoords(0);
  const x = rect.left + scroll.scrollLeft - offsets.x - htmlOffset.x;
  const y = rect.top + scroll.scrollTop - offsets.y - htmlOffset.y;
  return {
    x,
    y,
    width: rect.width,
    height: rect.height
  };
}
function isStaticPositioned(element) {
  return getComputedStyle$1(element).position === "static";
}
function getTrueOffsetParent(element, polyfill) {
  if (!isHTMLElement(element) || getComputedStyle$1(element).position === "fixed") {
    return null;
  }
  if (polyfill) {
    return polyfill(element);
  }
  let rawOffsetParent = element.offsetParent;
  if (getDocumentElement(element) === rawOffsetParent) {
    rawOffsetParent = rawOffsetParent.ownerDocument.body;
  }
  return rawOffsetParent;
}
function getOffsetParent(element, polyfill) {
  const win = getWindow(element);
  if (isTopLayer(element)) {
    return win;
  }
  if (!isHTMLElement(element)) {
    let svgOffsetParent = getParentNode(element);
    while (svgOffsetParent && !isLastTraversableNode(svgOffsetParent)) {
      if (isElement(svgOffsetParent) && !isStaticPositioned(svgOffsetParent)) {
        return svgOffsetParent;
      }
      svgOffsetParent = getParentNode(svgOffsetParent);
    }
    return win;
  }
  let offsetParent = getTrueOffsetParent(element, polyfill);
  while (offsetParent && isTableElement(offsetParent) && isStaticPositioned(offsetParent)) {
    offsetParent = getTrueOffsetParent(offsetParent, polyfill);
  }
  if (offsetParent && isLastTraversableNode(offsetParent) && isStaticPositioned(offsetParent) && !isContainingBlock(offsetParent)) {
    return win;
  }
  return offsetParent || getContainingBlock(element) || win;
}
const getElementRects = async function(data) {
  const getOffsetParentFn = this.getOffsetParent || getOffsetParent;
  const getDimensionsFn = this.getDimensions;
  const floatingDimensions = await getDimensionsFn(data.floating);
  return {
    reference: getRectRelativeToOffsetParent(data.reference, await getOffsetParentFn(data.floating), data.strategy),
    floating: {
      x: 0,
      y: 0,
      width: floatingDimensions.width,
      height: floatingDimensions.height
    }
  };
};
function isRTL(element) {
  return getComputedStyle$1(element).direction === "rtl";
}
const platform = {
  convertOffsetParentRelativeRectToViewportRelativeRect,
  getDocumentElement,
  getClippingRect,
  getOffsetParent,
  getElementRects,
  getClientRects,
  getDimensions,
  getScale,
  isElement,
  isRTL
};
const offset = offset$1;
const shift = shift$1;
const flip = flip$1;
const size = size$1;
const hide = hide$1;
const arrow = arrow$1;
const limitShift = limitShift$1;
const computePosition = (reference, floating, options) => {
  const cache = /* @__PURE__ */ new Map();
  const mergedOptions = {
    platform,
    ...options
  };
  const platformWithCache = {
    ...mergedOptions.platform,
    _c: cache
  };
  return computePosition$1(reference, floating, {
    ...mergedOptions,
    platform: platformWithCache
  });
};
function get(valueOrGetValue) {
  return typeof valueOrGetValue === "function" ? valueOrGetValue() : valueOrGetValue;
}
function getDPR(element) {
  if (typeof window === "undefined") return 1;
  const win = element.ownerDocument.defaultView || window;
  return win.devicePixelRatio || 1;
}
function roundByDPR(element, value) {
  const dpr = getDPR(element);
  return Math.round(value * dpr) / dpr;
}
function getFloatingContentCSSVars(name) {
  return {
    [`--bits-${name}-content-transform-origin`]: `var(--bits-floating-transform-origin)`,
    [`--bits-${name}-content-available-width`]: `var(--bits-floating-available-width)`,
    [`--bits-${name}-content-available-height`]: `var(--bits-floating-available-height)`,
    [`--bits-${name}-anchor-width`]: `var(--bits-floating-anchor-width)`,
    [`--bits-${name}-anchor-height`]: `var(--bits-floating-anchor-height)`
  };
}
function useFloating(options) {
  get(options.open) ?? true;
  const middlewareOption = get(options.middleware);
  const transformOption = get(options.transform) ?? true;
  const placementOption = get(options.placement) ?? "bottom";
  const strategyOption = get(options.strategy) ?? "absolute";
  const reference = options.reference;
  let x = 0;
  let y = 0;
  const floating = box(null);
  let strategy = strategyOption;
  let placement = placementOption;
  let middlewareData = {};
  let isPositioned = false;
  const floatingStyles = (() => {
    const initialStyles = { position: strategy, left: "0", top: "0" };
    if (!floating.current) {
      return initialStyles;
    }
    const xVal = roundByDPR(floating.current, x);
    const yVal = roundByDPR(floating.current, y);
    if (transformOption) {
      return {
        ...initialStyles,
        transform: `translate(${xVal}px, ${yVal}px)`,
        ...getDPR(floating.current) >= 1.5 && { willChange: "transform" }
      };
    }
    return {
      position: strategy,
      left: `${xVal}px`,
      top: `${yVal}px`
    };
  })();
  function update2() {
    if (reference.current === null || floating.current === null) return;
    computePosition(reference.current, floating.current, {
      middleware: middlewareOption,
      placement: placementOption,
      strategy: strategyOption
    }).then((position) => {
      x = position.x;
      y = position.y;
      strategy = position.strategy;
      placement = position.placement;
      middlewareData = position.middlewareData;
      isPositioned = true;
    });
  }
  return {
    floating,
    reference,
    get strategy() {
      return strategy;
    },
    get placement() {
      return placement;
    },
    get middlewareData() {
      return middlewareData;
    },
    get isPositioned() {
      return isPositioned;
    },
    get floatingStyles() {
      return floatingStyles;
    },
    get update() {
      return update2;
    }
  };
}
const OPPOSITE_SIDE = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right"
};
class FloatingRootState {
  anchorNode = box(null);
  customAnchorNode = box(null);
  triggerNode = box(null);
  constructor() {
  }
}
class FloatingContentState {
  opts;
  root;
  // nodes
  contentRef = box(null);
  wrapperRef = box(null);
  arrowRef = box(null);
  // ids
  arrowId = box(useId());
  #transformedStyle = once(() => {
    if (typeof this.opts.style === "string") return cssToStyleObj(this.opts.style);
    if (!this.opts.style) return {};
  });
  #updatePositionStrategy = void 0;
  #arrowSize = new ElementSize(() => this.arrowRef.current ?? void 0);
  #arrowWidth = once(() => this.#arrowSize?.width ?? 0);
  #arrowHeight = once(() => this.#arrowSize?.height ?? 0);
  #desiredPlacement = once(() => this.opts.side?.current + (this.opts.align.current !== "center" ? `-${this.opts.align.current}` : ""));
  #boundary = once(() => Array.isArray(this.opts.collisionBoundary.current) ? this.opts.collisionBoundary.current : [this.opts.collisionBoundary.current]);
  #hasExplicitBoundaries = once(() => this.#boundary().length > 0);
  get hasExplicitBoundaries() {
    return this.#hasExplicitBoundaries();
  }
  #detectOverflowOptions = once(() => ({
    padding: this.opts.collisionPadding.current,
    boundary: this.#boundary().filter(isNotNull),
    altBoundary: this.hasExplicitBoundaries
  }));
  get detectOverflowOptions() {
    return this.#detectOverflowOptions();
  }
  #availableWidth = void 0;
  #availableHeight = void 0;
  #anchorWidth = void 0;
  #anchorHeight = void 0;
  #middleware = once(() => [
    offset({
      mainAxis: this.opts.sideOffset.current + this.#arrowHeight(),
      alignmentAxis: this.opts.alignOffset.current
    }),
    this.opts.avoidCollisions.current && shift({
      mainAxis: true,
      crossAxis: false,
      limiter: this.opts.sticky.current === "partial" ? limitShift() : void 0,
      ...this.detectOverflowOptions
    }),
    this.opts.avoidCollisions.current && flip({ ...this.detectOverflowOptions }),
    size({
      ...this.detectOverflowOptions,
      apply: ({ rects, availableWidth, availableHeight }) => {
        const { width: anchorWidth, height: anchorHeight } = rects.reference;
        this.#availableWidth = availableWidth;
        this.#availableHeight = availableHeight;
        this.#anchorWidth = anchorWidth;
        this.#anchorHeight = anchorHeight;
      }
    }),
    this.arrowRef.current && arrow({
      element: this.arrowRef.current,
      padding: this.opts.arrowPadding.current
    }),
    transformOrigin({
      arrowWidth: this.#arrowWidth(),
      arrowHeight: this.#arrowHeight()
    }),
    this.opts.hideWhenDetached.current && hide({
      strategy: "referenceHidden",
      ...this.detectOverflowOptions
    })
  ].filter(Boolean));
  get middleware() {
    return this.#middleware();
  }
  floating;
  #placedSide = once(() => getSideFromPlacement(this.floating.placement));
  get placedSide() {
    return this.#placedSide();
  }
  #placedAlign = once(() => getAlignFromPlacement(this.floating.placement));
  get placedAlign() {
    return this.#placedAlign();
  }
  #arrowX = once(() => this.floating.middlewareData.arrow?.x ?? 0);
  get arrowX() {
    return this.#arrowX();
  }
  #arrowY = once(() => this.floating.middlewareData.arrow?.y ?? 0);
  get arrowY() {
    return this.#arrowY();
  }
  #cannotCenterArrow = once(() => this.floating.middlewareData.arrow?.centerOffset !== 0);
  get cannotCenterArrow() {
    return this.#cannotCenterArrow();
  }
  contentZIndex;
  #arrowBaseSide = once(() => OPPOSITE_SIDE[this.placedSide]);
  get arrowBaseSide() {
    return this.#arrowBaseSide();
  }
  #wrapperProps = once(() => ({
    id: this.opts.wrapperId.current,
    "data-bits-floating-content-wrapper": "",
    style: {
      ...this.floating.floatingStyles,
      // keep off page when measuring
      transform: this.floating.isPositioned ? this.floating.floatingStyles.transform : "translate(0, -200%)",
      minWidth: "max-content",
      zIndex: this.contentZIndex,
      "--bits-floating-transform-origin": `${this.floating.middlewareData.transformOrigin?.x} ${this.floating.middlewareData.transformOrigin?.y}`,
      "--bits-floating-available-width": `${this.#availableWidth}px`,
      "--bits-floating-available-height": `${this.#availableHeight}px`,
      "--bits-floating-anchor-width": `${this.#anchorWidth}px`,
      "--bits-floating-anchor-height": `${this.#anchorHeight}px`,
      // hide the content if using the hide middleware and should be hidden
      ...this.floating.middlewareData.hide?.referenceHidden && {
        visibility: "hidden",
        "pointer-events": "none"
      },
      ...this.#transformedStyle()
    },
    // Floating UI calculates logical alignment based the `dir` attribute
    dir: this.opts.dir.current
  }));
  get wrapperProps() {
    return this.#wrapperProps();
  }
  #props = once(() => ({
    "data-side": this.placedSide,
    "data-align": this.placedAlign,
    style: styleToString({
      ...this.#transformedStyle()
      // if the FloatingContent hasn't been placed yet (not all measurements done)
    })
  }));
  get props() {
    return this.#props();
  }
  #arrowStyle = once(() => ({
    position: "absolute",
    left: this.arrowX ? `${this.arrowX}px` : void 0,
    top: this.arrowY ? `${this.arrowY}px` : void 0,
    [this.arrowBaseSide]: 0,
    "transform-origin": {
      top: "",
      right: "0 0",
      bottom: "center 0",
      left: "100% 0"
    }[this.placedSide],
    transform: {
      top: "translateY(100%)",
      right: "translateY(50%) rotate(90deg) translateX(-50%)",
      bottom: "rotate(180deg)",
      left: "translateY(50%) rotate(-90deg) translateX(50%)"
    }[this.placedSide],
    visibility: this.cannotCenterArrow ? "hidden" : void 0
  }));
  get arrowStyle() {
    return this.#arrowStyle();
  }
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    if (opts.customAnchor) {
      this.root.customAnchorNode.current = opts.customAnchor.current;
    }
    watch(() => opts.customAnchor.current, (customAnchor) => {
      this.root.customAnchorNode.current = customAnchor;
    });
    useRefById({
      id: this.opts.wrapperId,
      ref: this.wrapperRef,
      deps: () => this.opts.enabled.current
    });
    useRefById({
      id: this.opts.id,
      ref: this.contentRef,
      deps: () => this.opts.enabled.current
    });
    this.floating = useFloating({
      strategy: () => this.opts.strategy.current,
      placement: () => this.#desiredPlacement(),
      middleware: () => this.middleware,
      reference: this.root.anchorNode,
      open: () => this.opts.enabled.current
    });
    watch(() => this.contentRef.current, (contentNode) => {
      if (!contentNode) return;
      this.contentZIndex = window.getComputedStyle(contentNode).zIndex;
    });
  }
}
class FloatingAnchorState {
  opts;
  root;
  ref = box(null);
  constructor(opts, root) {
    this.opts = opts;
    this.root = root;
    if (opts.virtualEl && opts.virtualEl.current) {
      root.triggerNode = box.from(opts.virtualEl.current);
    } else {
      useRefById({
        id: opts.id,
        ref: this.ref,
        onRefChange: (node) => {
          root.triggerNode.current = node;
        }
      });
    }
  }
}
const FloatingRootContext = new Context("Floating.Root");
const FloatingContentContext = new Context("Floating.Content");
function useFloatingRootState() {
  return FloatingRootContext.set(new FloatingRootState());
}
function useFloatingContentState(props) {
  return FloatingContentContext.set(new FloatingContentState(props, FloatingRootContext.get()));
}
function useFloatingAnchorState(props) {
  return new FloatingAnchorState(props, FloatingRootContext.get());
}
function transformOrigin(options) {
  return {
    name: "transformOrigin",
    options,
    fn(data) {
      const { placement, rects, middlewareData } = data;
      const cannotCenterArrow = middlewareData.arrow?.centerOffset !== 0;
      const isArrowHidden = cannotCenterArrow;
      const arrowWidth = isArrowHidden ? 0 : options.arrowWidth;
      const arrowHeight = isArrowHidden ? 0 : options.arrowHeight;
      const [placedSide, placedAlign] = getSideAndAlignFromPlacement(placement);
      const noArrowAlign = { start: "0%", center: "50%", end: "100%" }[placedAlign];
      const arrowXCenter = (middlewareData.arrow?.x ?? 0) + arrowWidth / 2;
      const arrowYCenter = (middlewareData.arrow?.y ?? 0) + arrowHeight / 2;
      let x = "";
      let y = "";
      if (placedSide === "bottom") {
        x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
        y = `${-arrowHeight}px`;
      } else if (placedSide === "top") {
        x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
        y = `${rects.floating.height + arrowHeight}px`;
      } else if (placedSide === "right") {
        x = `${-arrowHeight}px`;
        y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
      } else if (placedSide === "left") {
        x = `${rects.floating.width + arrowHeight}px`;
        y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
      }
      return { data: { x, y } };
    }
  };
}
function getSideAndAlignFromPlacement(placement) {
  const [side, align = "center"] = placement.split("-");
  return [side, align];
}
function getSideFromPlacement(placement) {
  return getSideAndAlignFromPlacement(placement)[0];
}
function getAlignFromPlacement(placement) {
  return getSideAndAlignFromPlacement(placement)[1];
}
function Floating_layer($$payload, $$props) {
  push();
  let { children } = $$props;
  useFloatingRootState();
  children?.($$payload);
  $$payload.out += `<!---->`;
  pop();
}
function Floating_layer_anchor($$payload, $$props) {
  push();
  let { id, children, virtualEl } = $$props;
  useFloatingAnchorState({
    id: box.with(() => id),
    virtualEl: box.with(() => virtualEl)
  });
  children?.($$payload);
  $$payload.out += `<!---->`;
  pop();
}
function Floating_layer_content($$payload, $$props) {
  push();
  let {
    content,
    side = "bottom",
    sideOffset = 0,
    align = "center",
    alignOffset = 0,
    id,
    arrowPadding = 0,
    avoidCollisions = true,
    collisionBoundary = [],
    collisionPadding = 0,
    hideWhenDetached = false,
    onPlaced = () => {
    },
    sticky = "partial",
    updatePositionStrategy = "optimized",
    strategy = "fixed",
    dir = "ltr",
    style = {},
    wrapperId = useId(),
    customAnchor = null,
    enabled
  } = $$props;
  const contentState = useFloatingContentState({
    side: box.with(() => side),
    sideOffset: box.with(() => sideOffset),
    align: box.with(() => align),
    alignOffset: box.with(() => alignOffset),
    id: box.with(() => id),
    arrowPadding: box.with(() => arrowPadding),
    avoidCollisions: box.with(() => avoidCollisions),
    collisionBoundary: box.with(() => collisionBoundary),
    collisionPadding: box.with(() => collisionPadding),
    hideWhenDetached: box.with(() => hideWhenDetached),
    onPlaced: box.with(() => onPlaced),
    sticky: box.with(() => sticky),
    updatePositionStrategy: box.with(() => updatePositionStrategy),
    strategy: box.with(() => strategy),
    dir: box.with(() => dir),
    style: box.with(() => style),
    enabled: box.with(() => enabled),
    wrapperId: box.with(() => wrapperId),
    customAnchor: box.with(() => customAnchor)
  });
  const mergedProps = mergeProps(contentState.wrapperProps, { style: { pointerEvents: "auto" } });
  content?.($$payload, {
    props: contentState.props,
    wrapperProps: mergedProps
  });
  $$payload.out += `<!---->`;
  pop();
}
function Floating_layer_content_static($$payload, $$props) {
  push();
  let { content } = $$props;
  content?.($$payload, { props: {}, wrapperProps: {} });
  $$payload.out += `<!---->`;
  pop();
}
function Popper_content($$payload, $$props) {
  let {
    content,
    isStatic = false,
    onPlaced,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  if (isStatic) {
    $$payload.out += "<!--[-->";
    Floating_layer_content_static($$payload, { content });
  } else {
    $$payload.out += "<!--[!-->";
    Floating_layer_content($$payload, spread_props([{ content, onPlaced }, restProps]));
  }
  $$payload.out += `<!--]-->`;
}
function Popper_layer_inner($$payload, $$props) {
  push();
  let {
    popper,
    onEscapeKeydown,
    escapeKeydownBehavior,
    preventOverflowTextSelection,
    id,
    onPointerDown,
    onPointerUp,
    side,
    sideOffset,
    align,
    alignOffset,
    arrowPadding,
    avoidCollisions,
    collisionBoundary,
    collisionPadding,
    sticky,
    hideWhenDetached,
    updatePositionStrategy,
    strategy,
    dir,
    preventScroll,
    wrapperId,
    style,
    onPlaced,
    onInteractOutside,
    onCloseAutoFocus,
    onOpenAutoFocus,
    onFocusOutside,
    interactOutsideBehavior = "close",
    loop,
    trapFocus = true,
    isValidEvent: isValidEvent2 = () => false,
    customAnchor = null,
    isStatic = false,
    enabled,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  {
    let content = function($$payload2, { props: floatingProps, wrapperProps }) {
      if (restProps.forceMount && enabled) {
        $$payload2.out += "<!--[-->";
        Scroll_lock($$payload2, { preventScroll });
      } else if (!restProps.forceMount) {
        $$payload2.out += "<!--[1-->";
        Scroll_lock($$payload2, { preventScroll });
      } else {
        $$payload2.out += "<!--[!-->";
      }
      $$payload2.out += `<!--]--> `;
      {
        let focusScope = function($$payload3, { props: focusScopeProps }) {
          Escape_layer($$payload3, {
            onEscapeKeydown,
            escapeKeydownBehavior,
            enabled,
            children: ($$payload4) => {
              {
                let children = function($$payload5, { props: dismissibleProps }) {
                  Text_selection_layer($$payload5, {
                    id,
                    preventOverflowTextSelection,
                    onPointerDown,
                    onPointerUp,
                    enabled,
                    children: ($$payload6) => {
                      popper?.($$payload6, {
                        props: mergeProps(restProps, floatingProps, dismissibleProps, focusScopeProps, { style: { pointerEvents: "auto" } }),
                        wrapperProps
                      });
                      $$payload6.out += `<!---->`;
                    }
                  });
                };
                Dismissible_layer($$payload4, {
                  id,
                  onInteractOutside,
                  onFocusOutside,
                  interactOutsideBehavior,
                  isValidEvent: isValidEvent2,
                  enabled,
                  children
                });
              }
            }
          });
        };
        Focus_scope($$payload2, {
          id,
          onOpenAutoFocus,
          onCloseAutoFocus,
          loop,
          trapFocus: enabled && trapFocus,
          forceMount: restProps.forceMount,
          focusScope
        });
      }
      $$payload2.out += `<!---->`;
    };
    Popper_content($$payload, {
      isStatic,
      id,
      side,
      sideOffset,
      align,
      alignOffset,
      arrowPadding,
      avoidCollisions,
      collisionBoundary,
      collisionPadding,
      sticky,
      hideWhenDetached,
      updatePositionStrategy,
      strategy,
      dir,
      wrapperId,
      style,
      onPlaced,
      customAnchor,
      enabled,
      content,
      $$slots: { content: true }
    });
  }
  pop();
}
function Popper_layer($$payload, $$props) {
  let {
    popper,
    present,
    onEscapeKeydown,
    escapeKeydownBehavior,
    preventOverflowTextSelection,
    id,
    onPointerDown,
    onPointerUp,
    side,
    sideOffset,
    align,
    alignOffset,
    arrowPadding,
    avoidCollisions,
    collisionBoundary,
    collisionPadding,
    sticky,
    hideWhenDetached,
    updatePositionStrategy,
    strategy,
    dir,
    preventScroll,
    wrapperId,
    style,
    onPlaced,
    onInteractOutside,
    onCloseAutoFocus,
    onOpenAutoFocus,
    onFocusOutside,
    interactOutsideBehavior = "close",
    loop,
    trapFocus = true,
    isValidEvent: isValidEvent2 = () => false,
    customAnchor = null,
    isStatic = false,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  {
    let presence = function($$payload2) {
      Popper_layer_inner($$payload2, spread_props([
        {
          popper,
          onEscapeKeydown,
          escapeKeydownBehavior,
          preventOverflowTextSelection,
          id,
          onPointerDown,
          onPointerUp,
          side,
          sideOffset,
          align,
          alignOffset,
          arrowPadding,
          avoidCollisions,
          collisionBoundary,
          collisionPadding,
          sticky,
          hideWhenDetached,
          updatePositionStrategy,
          strategy,
          dir,
          preventScroll,
          wrapperId,
          style,
          onPlaced,
          customAnchor,
          isStatic,
          enabled: present,
          onInteractOutside,
          onCloseAutoFocus,
          onOpenAutoFocus,
          interactOutsideBehavior,
          loop,
          trapFocus,
          isValidEvent: isValidEvent2,
          onFocusOutside,
          forceMount: false
        },
        restProps
      ]));
    };
    Presence_layer($$payload, spread_props([
      { id, present },
      restProps,
      { presence, $$slots: { presence: true } }
    ]));
  }
}
function Popper_layer_force_mount($$payload, $$props) {
  let {
    popper,
    onEscapeKeydown,
    escapeKeydownBehavior,
    preventOverflowTextSelection,
    id,
    onPointerDown,
    onPointerUp,
    side,
    sideOffset,
    align,
    alignOffset,
    arrowPadding,
    avoidCollisions,
    collisionBoundary,
    collisionPadding,
    sticky,
    hideWhenDetached,
    updatePositionStrategy,
    strategy,
    dir,
    preventScroll,
    wrapperId,
    style,
    onPlaced,
    onInteractOutside,
    onCloseAutoFocus,
    onOpenAutoFocus,
    onFocusOutside,
    interactOutsideBehavior = "close",
    loop,
    trapFocus = true,
    isValidEvent: isValidEvent2 = () => false,
    customAnchor = null,
    isStatic = false,
    enabled,
    $$slots,
    $$events,
    ...restProps
  } = $$props;
  Popper_layer_inner($$payload, spread_props([
    {
      popper,
      onEscapeKeydown,
      escapeKeydownBehavior,
      preventOverflowTextSelection,
      id,
      onPointerDown,
      onPointerUp,
      side,
      sideOffset,
      align,
      alignOffset,
      arrowPadding,
      avoidCollisions,
      collisionBoundary,
      collisionPadding,
      sticky,
      hideWhenDetached,
      updatePositionStrategy,
      strategy,
      dir,
      preventScroll,
      wrapperId,
      style,
      onPlaced,
      customAnchor,
      isStatic,
      enabled,
      onInteractOutside,
      onCloseAutoFocus,
      onOpenAutoFocus,
      interactOutsideBehavior,
      loop,
      trapFocus,
      isValidEvent: isValidEvent2,
      onFocusOutside
    },
    restProps,
    { forceMount: true }
  ]));
}
const getNumber = (name) => {
  const charactersArray = Array.from(name);
  let charactersCodesSum = 0;
  charactersArray.forEach((charactersArrayItem) => {
    return charactersCodesSum += charactersArrayItem.charCodeAt(0);
  });
  return charactersCodesSum;
};
const getDigit = (number, ntn) => {
  return Math.floor(number / Math.pow(10, ntn) % 10);
};
const getBoolean = (number, ntn) => {
  return !(getDigit(number, ntn) % 2);
};
const getUnit = (number, range, index) => {
  let value = number % range;
  if (index && getDigit(number, index) % 2 === 0) {
    return -value;
  } else
    return value;
};
const getRandomColor = (number, colors, range) => {
  return colors[number % range];
};
const getContrast = (hexcolor) => {
  if (hexcolor.slice(0, 1) === "#") {
    hexcolor = hexcolor.slice(1);
  }
  var r = parseInt(hexcolor.substr(0, 2), 16);
  var g = parseInt(hexcolor.substr(2, 2), 16);
  var b = parseInt(hexcolor.substr(4, 2), 16);
  var yiq = (r * 299 + g * 587 + b * 114) / 1e3;
  return yiq >= 128 ? "black" : "white";
};
function getRandomInt(min2, max2) {
  min2 = Math.ceil(min2);
  max2 = Math.floor(max2);
  return Math.floor(Math.random() * (max2 - min2) + min2);
}
const getRandomId = () => {
  const array = [...Array(8)].map(() => getRandomInt(0, 255));
  return array.toString();
};
const DEFAULTS = {
  colors: ["#92A1C6", "#146A7C", "#F0AB3D", "#C271B4", "#C20D90"],
  name: "Clara Barton",
  square: false,
  size: 40
};
function AvatarBeam($$payload, $$props) {
  push();
  const SIZE = 36;
  function generateData(name2, colors2) {
    const numFromName = getNumber(name2);
    const range = colors2 && colors2.length;
    const wrapperColor = getRandomColor(numFromName, colors2, range);
    const preTranslateX = getUnit(numFromName, 10, 1);
    const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + SIZE / 9 : preTranslateX;
    const preTranslateY = getUnit(numFromName, 10, 2);
    const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + SIZE / 9 : preTranslateY;
    const data2 = {
      wrapperColor,
      faceColor: getContrast(wrapperColor),
      backgroundColor: getRandomColor(numFromName + 13, colors2, range),
      wrapperTranslateX,
      wrapperTranslateY,
      wrapperRotate: getUnit(numFromName, 360),
      wrapperScale: 1 + getUnit(numFromName, SIZE / 12) / 10,
      isMouthOpen: getBoolean(numFromName, 2),
      isCircle: getBoolean(numFromName, 1),
      eyeSpread: getUnit(numFromName, 5),
      mouthSpread: getUnit(numFromName, 3),
      faceRotate: getUnit(numFromName, 10, 3),
      faceTranslateX: wrapperTranslateX > SIZE / 6 ? wrapperTranslateX / 2 : getUnit(numFromName, 8, 1),
      faceTranslateY: wrapperTranslateY > SIZE / 6 ? wrapperTranslateY / 2 : getUnit(numFromName, 7, 2)
    };
    return data2;
  }
  let size2 = fallback($$props["size"], () => DEFAULTS.size, true);
  let name = fallback($$props["name"], () => DEFAULTS.name, true);
  let square = fallback($$props["square"], () => DEFAULTS.square, true);
  let colors = fallback($$props["colors"], () => DEFAULTS.colors, true);
  const data = generateData(name, colors);
  const maskId = `mask__beam${getRandomId()}`;
  $$payload.out += `<svg${attr("viewBox", "0 0 " + SIZE + " " + SIZE)} fill="none" xmlns="http://www.w3.org/2000/svg"${attr("width", size2)}${attr("height", size2)} data-testid="avatar-beam"><mask${attr("id", maskId)} maskUnits="userSpaceOnUse"${attr("x", 0)}${attr("y", 0)}${attr("width", SIZE)}${attr("height", SIZE)}><rect${attr("width", SIZE)}${attr("height", SIZE)}${attr("rx", square ? void 0 : SIZE * 2)} fill="white"></rect></mask><g${attr("mask", `url(#${stringify(maskId)})`)}><rect${attr("width", SIZE)}${attr("height", SIZE)}${attr("fill", data.backgroundColor)}></rect><rect x="0" y="0"${attr("width", SIZE)}${attr("height", SIZE)}${attr("transform", "translate(" + data.wrapperTranslateX + " " + data.wrapperTranslateY + ") rotate(" + data.wrapperRotate + " " + SIZE / 2 + " " + SIZE / 2 + ") scale(" + data.wrapperScale + ")")}${attr("fill", data.wrapperColor)}${attr("rx", data.isCircle ? SIZE : SIZE / 6)}></rect><g${attr("transform", "translate(" + data.faceTranslateX + " " + data.faceTranslateY + ") rotate(" + data.faceRotate + " " + SIZE / 2 + " " + SIZE / 2 + ")")}>`;
  if (data.isMouthOpen) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<path${attr("d", "M15 " + (19 + data.mouthSpread) + "c2 1 4 1 6 0")}${attr("stroke", data.faceColor)} fill="none" stroke-linecap="round"></path>`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<path${attr("d", "M13," + (19 + data.mouthSpread) + " a1,0.75 0 0,0 10,0")}${attr("fill", data.faceColor)}></path>`;
  }
  $$payload.out += `<!--]--><rect${attr("x", 14 - data.eyeSpread)}${attr("y", 14)}${attr("width", 1.5)}${attr("height", 2)}${attr("rx", 1)} stroke="none"${attr("fill", data.faceColor)}></rect><rect${attr("x", 20 + data.eyeSpread)}${attr("y", 14)}${attr("width", 1.5)}${attr("height", 2)}${attr("rx", 1)} stroke="none"${attr("fill", data.faceColor)}></rect></g></g></svg>`;
  bind_props($$props, { size: size2, name, square, colors });
  pop();
}
function AvatarImage($$payload, $$props) {
  let { handle, avatarUrl, className } = $$props;
  $$payload.out += `<!---->`;
  Avatar($$payload, {
    class: `w-8 aspect-square ${className}`,
    children: ($$payload2) => {
      $$payload2.out += `<!---->`;
      Avatar_image($$payload2, { src: avatarUrl, class: "rounded-full" });
      $$payload2.out += `<!----> <!---->`;
      Avatar_fallback($$payload2, {
        children: ($$payload3) => {
          AvatarBeam($$payload3, { name: handle });
        },
        $$slots: { default: true }
      });
      $$payload2.out += `<!---->`;
    },
    $$slots: { default: true }
  });
  $$payload.out += `<!---->`;
}
function writableDerived(origins, derive, reflect, initial) {
  var childDerivedSetter, originValues, blockNextDerive = false;
  var reflectOldValues = reflect.length >= 2;
  var wrappedDerive = (got, set, update3) => {
    childDerivedSetter = set;
    if (reflectOldValues) {
      originValues = got;
    }
    if (!blockNextDerive) {
      let returned = derive(got, set, update3);
      if (derive.length < 2) {
        set(returned);
      } else {
        return returned;
      }
    }
    blockNextDerive = false;
  };
  var childDerived = derived(origins, wrappedDerive, initial);
  var singleOrigin = !Array.isArray(origins);
  function doReflect(reflecting) {
    var setWith = reflect(reflecting, originValues);
    if (singleOrigin) {
      blockNextDerive = true;
      origins.set(setWith);
    } else {
      setWith.forEach((value, i) => {
        blockNextDerive = true;
        origins[i].set(value);
      });
    }
    blockNextDerive = false;
  }
  var tryingSet = false;
  function update2(fn) {
    var isUpdated, mutatedBySubscriptions, oldValue, newValue;
    if (tryingSet) {
      newValue = fn(get$1(childDerived));
      childDerivedSetter(newValue);
      return;
    }
    var unsubscribe = childDerived.subscribe((value) => {
      if (!tryingSet) {
        oldValue = value;
      } else if (!isUpdated) {
        isUpdated = true;
      } else {
        mutatedBySubscriptions = true;
      }
    });
    newValue = fn(oldValue);
    tryingSet = true;
    childDerivedSetter(newValue);
    unsubscribe();
    tryingSet = false;
    if (mutatedBySubscriptions) {
      newValue = get$1(childDerived);
    }
    if (isUpdated) {
      doReflect(newValue);
    }
  }
  return {
    subscribe: childDerived.subscribe,
    set(value) {
      update2(() => value);
    },
    update: update2
  };
}
const TOAST_LIMIT = 20;
const toasts = writable([]);
const pausedAt = writable(null);
const toastTimeouts = /* @__PURE__ */ new Map();
const addToRemoveQueue = (toastId) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }
  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    remove(toastId);
  }, 1e3);
  toastTimeouts.set(toastId, timeout);
};
const clearFromRemoveQueue = (toastId) => {
  const timeout = toastTimeouts.get(toastId);
  if (timeout) {
    clearTimeout(timeout);
  }
};
function update(toast2, clearTimeout2 = true) {
  if (clearTimeout2 && toast2.id) {
    clearFromRemoveQueue(toast2.id);
  }
  toasts.update(($toasts) => $toasts.map((t) => t.id === toast2.id ? { ...t, ...toast2 } : t));
}
function add(toast2) {
  toasts.update(($toasts) => [toast2, ...$toasts].slice(0, TOAST_LIMIT));
}
function upsert(toast2) {
  if (get$1(toasts).find((t) => t.id === toast2.id)) {
    update(toast2);
  } else {
    add(toast2);
  }
}
function dismiss(toastId) {
  toasts.update(($toasts) => {
    if (toastId) {
      addToRemoveQueue(toastId);
    } else {
      $toasts.forEach((toast2) => {
        addToRemoveQueue(toast2.id);
      });
    }
    return $toasts.map((t) => t.id === toastId || toastId === void 0 ? { ...t, visible: false } : t);
  });
}
function remove(toastId) {
  toasts.update(($toasts) => {
    if (toastId === void 0) {
      return [];
    }
    return $toasts.filter((t) => t.id !== toastId);
  });
}
function startPause(time) {
  pausedAt.set(time);
}
function endPause(time) {
  let diff;
  pausedAt.update(($pausedAt) => {
    diff = time - ($pausedAt || 0);
    return null;
  });
  toasts.update(($toasts) => $toasts.map((t) => ({
    ...t,
    pauseDuration: t.pauseDuration + diff
  })));
}
const defaultTimeouts = {
  blank: 4e3,
  error: 4e3,
  success: 2e3,
  loading: Infinity,
  custom: 4e3
};
function useToasterStore(toastOptions = {}) {
  const mergedToasts = writableDerived(toasts, ($toasts) => $toasts.map((t) => ({
    ...toastOptions,
    ...toastOptions[t.type],
    ...t,
    duration: t.duration || toastOptions[t.type]?.duration || toastOptions?.duration || defaultTimeouts[t.type],
    style: [toastOptions.style, toastOptions[t.type]?.style, t.style].join(";")
  })), ($toasts) => $toasts);
  return {
    toasts: mergedToasts,
    pausedAt
  };
}
const isFunction = (valOrFunction) => typeof valOrFunction === "function";
const resolveValue = (valOrFunction, arg) => isFunction(valOrFunction) ? valOrFunction(arg) : valOrFunction;
const genId = /* @__PURE__ */ (() => {
  let count = 0;
  return () => {
    count += 1;
    return count.toString();
  };
})();
const prefersReducedMotion = /* @__PURE__ */ (() => {
  let shouldReduceMotion;
  return () => {
    if (shouldReduceMotion === void 0 && typeof window !== "undefined") {
      const mediaQuery = matchMedia("(prefers-reduced-motion: reduce)");
      shouldReduceMotion = !mediaQuery || mediaQuery.matches;
    }
    return shouldReduceMotion;
  };
})();
const createToast = (message, type = "blank", opts) => ({
  createdAt: Date.now(),
  visible: true,
  type,
  ariaProps: {
    role: "status",
    "aria-live": "polite"
  },
  message,
  pauseDuration: 0,
  icon: opts?.icon,
  duration: opts?.duration,
  iconTheme: opts?.iconTheme,
  position: opts?.position,
  props: opts?.props,
  id: opts?.id || genId()
});
const createHandler = (type) => (message, options) => {
  const toast2 = createToast(message, type, options);
  upsert(toast2);
  return toast2.id;
};
const toast = (message, opts) => createHandler("blank")(message, opts);
toast.error = createHandler("error");
toast.success = createHandler("success");
toast.loading = createHandler("loading");
toast.custom = createHandler("custom");
toast.dismiss = (toastId) => {
  dismiss(toastId);
};
toast.remove = (toastId) => remove(toastId);
toast.promise = (promise, msgs, opts) => {
  const id = toast.loading(msgs.loading, { ...opts, ...opts?.loading });
  promise.then((p) => {
    toast.success(resolveValue(msgs.success, p), {
      id,
      ...opts,
      ...opts?.success
    });
    return p;
  }).catch((e) => {
    toast.error(resolveValue(msgs.error, e), {
      id,
      ...opts,
      ...opts?.error
    });
  });
  return promise;
};
export {
  Avatar as A,
  DEFAULTS as D,
  Escape_layer as E,
  Floating_layer as F,
  Hidden_input as H,
  Popper_layer_force_mount as P,
  Scroll_lock as S,
  Text_selection_layer as T,
  Popper_layer as a,
  Floating_layer_anchor as b,
  getNumber as c,
  getRandomColor as d,
  update as e,
  endPause as f,
  getRandomId as g,
  Portal as h,
  Avatar_image as i,
  Avatar_fallback as j,
  AvatarImage as k,
  Focus_scope as l,
  Dismissible_layer as m,
  getFloatingContentCSSVars as n,
  tabbable as o,
  prefersReducedMotion as p,
  focusable as q,
  isTabbable as r,
  startPause as s,
  toast as t,
  useToasterStore as u,
  getTabIndex as v,
  isFocusable as w,
  AvatarBeam as x
};
