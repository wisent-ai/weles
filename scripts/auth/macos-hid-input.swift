#!/usr/bin/env swift

import ApplicationServices
import Foundation

let submit = CommandLine.arguments.contains("--return")
let targetPID: pid_t? = {
    guard let index = CommandLine.arguments.firstIndex(of: "--pid"),
          CommandLine.arguments.indices.contains(index + 1),
          let value = Int32(CommandLine.arguments[index + 1]),
          value > 0
    else { return nil }
    return value
}()
let deleteCount: Int = {
    guard let index = CommandLine.arguments.firstIndex(of: "--delete"),
          CommandLine.arguments.indices.contains(index + 1),
          let value = Int(CommandLine.arguments[index + 1]),
          value >= 0, value <= 4096
    else { return 0 }
    return value
}()
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: input, encoding: .utf8) else {
    FileHandle.standardError.write(Data("stdin must be UTF-8\n".utf8))
    exit(64)
}

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("Accessibility permission is required\n".utf8))
    exit(77)
}

let source = CGEventSource(stateID: .combinedSessionState)
func deliver(_ event: CGEvent) {
    if let targetPID {
        event.postToPid(targetPID)
    } else {
        event.post(tap: .cghidEventTap)
    }
}


func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    let usesShift = flags.contains(.maskShift)
    let shiftCode: CGKeyCode = 56
    guard
        let shiftDown = usesShift ? CGEvent(keyboardEventSource: source, virtualKey: shiftCode, keyDown: true) : nil,
        let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false),
        let shiftUp = usesShift ? CGEvent(keyboardEventSource: source, virtualKey: shiftCode, keyDown: false) : nil
    else {
        if !usesShift,
           let plainDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
           let plainUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
            deliver(plainDown)
            usleep(20_000)
            deliver(plainUp)
            usleep(30_000)
            return
        }
        exit(70)
    }
    shiftDown.flags = .maskShift
    down.flags = .maskShift
    up.flags = .maskShift
    deliver(shiftDown)
    usleep(10_000)
    deliver(down)
    usleep(20_000)
    deliver(up)
    usleep(10_000)
    deliver(shiftUp)
    usleep(30_000)
}

let baseKeys: [Character: CGKeyCode] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5,
    "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45,
    "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32,
    "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
    "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41,
    "'": 39, ",": 43, ".": 47, "/": 44, "`": 50, " ": 49,
]
let shiftedKeys: [Character: CGKeyCode] = [
    "~": 50, "!": 18, "@": 19, "#": 20, "$": 21, "%": 23,
    "^": 22, "&": 26, "*": 28, "(": 25, ")": 29,
    "_": 27, "+": 24, "{": 33, "}": 30, "|": 42, ":": 41,
    "\"": 39, "<": 43, ">": 47, "?": 44,
]

func postCharacter(_ character: Character) {
    if let keyCode = baseKeys[character] {
        postKey(keyCode)
        return
    }
    if let keyCode = shiftedKeys[character] {
        postKey(keyCode, flags: .maskShift)
        return
    }
    let lower = Character(String(character).lowercased())
    if character.isUppercase, let keyCode = baseKeys[lower] {
        postKey(keyCode, flags: .maskShift)
        return
    }
    FileHandle.standardError.write(Data("unsupported input character\n".utf8))
    exit(65)
}

for _ in 0..<deleteCount { postKey(51) }
for character in text { postCharacter(character) }
if submit { postKey(36) }
