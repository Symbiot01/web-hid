'use strict';

/**
 * UI Events KeyboardEvent.code → USB HID keyboard usage (page 0x07).
 * Physical key identities only. Target OS applies layout.
 */
(function (global) {
  const CODE_TO_HID = Object.freeze({
    KeyA: 0x04,
    KeyB: 0x05,
    KeyC: 0x06,
    KeyD: 0x07,
    KeyE: 0x08,
    KeyF: 0x09,
    KeyG: 0x0a,
    KeyH: 0x0b,
    KeyI: 0x0c,
    KeyJ: 0x0d,
    KeyK: 0x0e,
    KeyL: 0x0f,
    KeyM: 0x10,
    KeyN: 0x11,
    KeyO: 0x12,
    KeyP: 0x13,
    KeyQ: 0x14,
    KeyR: 0x15,
    KeyS: 0x16,
    KeyT: 0x17,
    KeyU: 0x18,
    KeyV: 0x19,
    KeyW: 0x1a,
    KeyX: 0x1b,
    KeyY: 0x1c,
    KeyZ: 0x1d,
    Digit1: 0x1e,
    Digit2: 0x1f,
    Digit3: 0x20,
    Digit4: 0x21,
    Digit5: 0x22,
    Digit6: 0x23,
    Digit7: 0x24,
    Digit8: 0x25,
    Digit9: 0x26,
    Digit0: 0x27,
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    F1: 0x3a,
    F2: 0x3b,
    F3: 0x3c,
    F4: 0x3d,
    F5: 0x3e,
    F6: 0x3f,
    F7: 0x40,
    F8: 0x41,
    F9: 0x42,
    F10: 0x43,
    F11: 0x44,
    F12: 0x45,
    PrintScreen: 0x46,
    ScrollLock: 0x47,
    Pause: 0x48,
    Insert: 0x49,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
    NumLock: 0x53,
    NumpadDivide: 0x54,
    NumpadMultiply: 0x55,
    NumpadSubtract: 0x56,
    NumpadAdd: 0x57,
    NumpadEnter: 0x58,
    Numpad1: 0x59,
    Numpad2: 0x5a,
    Numpad3: 0x5b,
    Numpad4: 0x5c,
    Numpad5: 0x5d,
    Numpad6: 0x5e,
    Numpad7: 0x5f,
    Numpad8: 0x60,
    Numpad9: 0x61,
    Numpad0: 0x62,
    NumpadDecimal: 0x63,
    IntlBackslash: 0x64,
    ContextMenu: 0x65,
    NumpadEqual: 0x67,
    F13: 0x68,
    F14: 0x69,
    F15: 0x6a,
    F16: 0x6b,
    F17: 0x6c,
    F18: 0x6d,
    F19: 0x6e,
    F20: 0x6f,
    F21: 0x70,
    F22: 0x71,
    F23: 0x72,
    F24: 0x73,
    IntlRo: 0x87,
    IntlYen: 0x89,
    Convert: 0x8a,
    NonConvert: 0x8b,
    KanaMode: 0x88,
    Lang1: 0x90,
    Lang2: 0x91,
    ControlLeft: 0xe0,
    ShiftLeft: 0xe1,
    AltLeft: 0xe2,
    MetaLeft: 0xe3,
    ControlRight: 0xe4,
    ShiftRight: 0xe5,
    AltRight: 0xe6,
    MetaRight: 0xe7,
  });

  function hidUsageFromCode(code) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 32) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(CODE_TO_HID, code)) {
      return null;
    }
    return CODE_TO_HID[code];
  }

  function isHidKeyboardUsage(usage) {
    if (!Number.isInteger(usage)) {
      return false;
    }
    if (usage >= 0xe0 && usage <= 0xe7) {
      return true;
    }
    return usage > 0 && usage < 0xa5;
  }

  const FLAG_SEQ = 0x01;
  const OP_KEY_DOWN = 1;
  const OP_KEY_UP = 2;
  const OP_RELEASE_ALL = 3;
  const OP_MOUSE = 4;

  let seq = 0;

  function nextSeq() {
    seq = (seq + 1) & 0xffff;
    return seq;
  }

  /**
   * Build a keyboard or releaseAll live binary frame (little-endian).
   * @param {number} op
   * @param {number} [usage]
   * @returns {ArrayBuffer}
   */
  function buildFrame(op, usage) {
    if (op === OP_RELEASE_ALL) {
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      view.setUint8(0, OP_RELEASE_ALL);
      view.setUint8(1, FLAG_SEQ);
      view.setUint16(2, nextSeq(), true);
      return buf;
    }
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, op);
    view.setUint8(1, FLAG_SEQ);
    view.setUint16(2, nextSeq(), true);
    view.setUint8(4, usage);
    return buf;
  }

  /**
   * Relative mouse frame: buttons u8, dx i16, dy i16, wheel i8. Total 10 bytes.
   * @param {number} buttons
   * @param {number} dx
   * @param {number} dy
   * @param {number} [wheel]
   * @returns {ArrayBuffer}
   */
  function buildMouseFrame(buttons, dx, dy, wheel) {
    const buf = new ArrayBuffer(10);
    const view = new DataView(buf);
    view.setUint8(0, OP_MOUSE);
    view.setUint8(1, FLAG_SEQ);
    view.setUint16(2, nextSeq(), true);
    view.setUint8(4, buttons & 0x07);
    view.setInt16(5, clampI16(dx), true);
    view.setInt16(7, clampI16(dy), true);
    view.setInt8(9, clampI8(wheel || 0));
    return buf;
  }

  function clampI16(n) {
    const v = Number(n) || 0;
    if (v > 32767) {
      return 32767;
    }
    if (v < -32768) {
      return -32768;
    }
    return v | 0;
  }

  function clampI8(n) {
    const v = Number(n) || 0;
    if (v > 127) {
      return 127;
    }
    if (v < -127) {
      return -127;
    }
    return v | 0;
  }

  global.HidKeymap = {
    hidUsageFromCode,
    isHidKeyboardUsage,
    buildFrame,
    buildMouseFrame,
    OP_KEY_DOWN,
    OP_KEY_UP,
    OP_RELEASE_ALL,
    OP_MOUSE,
  };
})(window);
