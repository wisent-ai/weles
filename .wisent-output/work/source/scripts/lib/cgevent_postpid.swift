// cgevent_postpid — post CGEvents to a specific PID without moving the
// system cursor or touching the global focus.
//
// Replaces the prior native CLI tool for parallel-safe humanized atoms.
// The prior tool used CGEventPost(kCGHIDEventTap, …) which hijacks the one
// global cursor. CGEventPostToPid routes the event into the target
// application's per-process event queue: many trajectories can drive
// different Chromium PIDs at the same time and none of them touches the
// user's cursor.
//
// Build: swiftc -O cgevent_postpid.swift -o cgevent_postpid
//
// Usage:
//   cgevent_postpid --pid <PID> move <X> <Y>
//   cgevent_postpid --pid <PID> click <X> <Y>           # left button down+up
//   cgevent_postpid --pid <PID> type <STRING>           # unicode chars
//   cgevent_postpid --pid <PID> key <NAME>              # return,tab,esc,delete,space,arrow-{up,down,left,right}
//   cgevent_postpid --pid <PID> kd <MOD>                # mod key down: cmd,shift,opt,ctrl
//   cgevent_postpid --pid <PID> ku <MOD>                # mod key up
//   cgevent_postpid --pid <PID> select-all-and-delete   # cmd+a then delete

import Foundation
import CoreGraphics

func die(_ msg: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 4, args[1] == "--pid", let pid = Int32(args[2]) else {
    die("usage: cgevent_postpid --pid <PID> <verb> [args]")
}
let verb = args[3]
let rest = Array(args.dropFirst(4))

let keyMap: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "esc": 0x35, "escape": 0x35,
    "delete": 0x33, "backspace": 0x33,
    "space": 0x31,
    "arrow-down": 0x7D, "down": 0x7D,
    "arrow-up": 0x7E, "up": 0x7E,
    "arrow-left": 0x7B, "left": 0x7B,
    "arrow-right": 0x7C, "right": 0x7C,
]

let modMap: [String: (CGKeyCode, CGEventFlags)] = [
    "cmd": (0x37, .maskCommand),
    "shift": (0x38, .maskShift),
    "opt": (0x3A, .maskAlternate), "alt": (0x3A, .maskAlternate),
    "ctrl": (0x3B, .maskControl), "control": (0x3B, .maskControl),
]

func post(_ event: CGEvent?) {
    guard let ev = event else { return }
    ev.postToPid(pid)
}

func mouseMove(_ x: CGFloat, _ y: CGFloat) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                 mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
}

func mouseClick(_ x: CGFloat, _ y: CGFloat) {
    let pos = CGPoint(x: x, y: y)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                 mouseCursorPosition: pos, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                 mouseCursorPosition: pos, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                 mouseCursorPosition: pos, mouseButton: .left))
}

func keyTap(_ keycode: CGKeyCode, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: keycode, keyDown: true) {
        down.flags = flags
        down.postToPid(pid)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: keycode, keyDown: false) {
        up.flags = flags
        up.postToPid(pid)
    }
}

func typeUnicode(_ s: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    for scalar in s.unicodeScalars {
        var utf16: [UniChar] = Array(String(scalar).utf16)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.postToPid(pid)
        }
        if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.postToPid(pid)
        }
    }
}

switch verb {
case "move":
    guard rest.count == 2, let x = Double(rest[0]), let y = Double(rest[1]) else { die("move <X> <Y>") }
    mouseMove(CGFloat(x), CGFloat(y))
case "click":
    guard rest.count == 2, let x = Double(rest[0]), let y = Double(rest[1]) else { die("click <X> <Y>") }
    mouseClick(CGFloat(x), CGFloat(y))
case "type":
    guard !rest.isEmpty else { die("type <STRING>") }
    typeUnicode(rest.joined(separator: " "))
case "key":
    guard let name = rest.first, let kc = keyMap[name.lowercased()] else { die("key <NAME>") }
    keyTap(kc)
case "kd":
    guard let name = rest.first, let m = modMap[name.lowercased()] else { die("kd <MOD>") }
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: m.0, keyDown: true) {
        down.flags = m.1
        down.postToPid(pid)
    }
case "ku":
    guard let name = rest.first, let m = modMap[name.lowercased()] else { die("ku <MOD>") }
    let src = CGEventSource(stateID: .hidSystemState)
    if let up = CGEvent(keyboardEventSource: src, virtualKey: m.0, keyDown: false) {
        up.flags = []
        up.postToPid(pid)
    }
case "select-all-and-delete":
    let src = CGEventSource(stateID: .hidSystemState)
    if let aDown = CGEvent(keyboardEventSource: src, virtualKey: 0x00, keyDown: true) {
        aDown.flags = .maskCommand
        aDown.postToPid(pid)
    }
    if let aUp = CGEvent(keyboardEventSource: src, virtualKey: 0x00, keyDown: false) {
        aUp.flags = .maskCommand
        aUp.postToPid(pid)
    }
    keyTap(0x33)
default:
    die("unknown verb: \(verb)")
}
