import XCTest
@testable import TypozaKit

final class AIKitTests: XCTestCase {
    func testWebCanCallSyncAndAIButNotSecrets() {
        XCTAssertTrue(HelperPolicy.webCallable("sync.status"))
        XCTAssertTrue(HelperPolicy.webCallable("ai.chat.send"))
        XCTAssertTrue(HelperPolicy.webCallable("ai.secret.set"))
        XCTAssertFalse(HelperPolicy.webCallable("ai.secrets"))
        XCTAssertFalse(HelperPolicy.webCallable("session.resume"))
        XCTAssertFalse(HelperPolicy.webCallable("helper.version"))
    }

    func testSecretRefsAreLimitedToContractPrefixes() {
        XCTAssertTrue(AISecretStore.isValidRef("provider:abc123"))
        XCTAssertTrue(AISecretStore.isValidRef("mcp:srv1:GITHUB_TOKEN"))
        XCTAssertTrue(AISecretStore.isValidRef("mcp-oauth:srv1"))
        XCTAssertFalse(AISecretStore.isValidRef("provider:"))
        XCTAssertFalse(AISecretStore.isValidRef("session"))
        XCTAssertFalse(AISecretStore.isValidRef("app.typoza.mac.sync"))
        XCTAssertFalse(AISecretStore.isValidRef("provider:a\nb"))
        XCTAssertFalse(AISecretStore.isValidRef("provider:" + String(repeating: "x", count: 300)))
    }

    func testHelperMayStoreOnlyMCPOAuthTokens() {
        XCTAssertTrue(AISecretStore.helperMayStore("mcp-oauth:srv1"))
        XCTAssertFalse(AISecretStore.helperMayStore("mcp-oauth:"))
        XCTAssertFalse(AISecretStore.helperMayStore("provider:abc"))
        XCTAssertFalse(AISecretStore.helperMayStore("mcp:srv1:TOKEN"))
        XCTAssertFalse(AISecretStore.helperMayStore("mcp-oauth:a\nb"))
    }
}
