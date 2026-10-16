import XCTest
@testable import TypozaKit

final class MenuKeyLabelTests: XCTestCase {
    func testModifierOrderAndLetters() {
        XCTAssertEqual(MenuKeyLabel.text(key: "s", control: false, option: true, shift: true, command: true), "⌥⇧⌘S")
        XCTAssertEqual(MenuKeyLabel.text(key: "l", control: true, option: false, shift: false, command: true), "⌃⌘L")
        XCTAssertEqual(MenuKeyLabel.text(key: "-", control: true, option: false, shift: false, command: false), "⌃-")
        XCTAssertEqual(MenuKeyLabel.text(key: "/", control: false, option: false, shift: false, command: true), "⌘/")
    }

    func testFunctionAndArrowKeys() {
        let f8 = String(Character(UnicodeScalar(UInt32(0xF70B))!))
        XCTAssertEqual(MenuKeyLabel.text(key: f8, control: false, option: false, shift: false, command: false), "F8")
        let up = String(Character(UnicodeScalar(UInt32(0xF700))!))
        XCTAssertEqual(MenuKeyLabel.text(key: up, control: false, option: false, shift: true, command: true), "⇧⌘↑")
        XCTAssertEqual(MenuKeyLabel.text(key: " ", control: true, option: false, shift: false, command: true), "⌃⌘空格")
    }
}
