import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

private actor TalkReplyProbe {
    var responses: [String]
    var current = true
    var retireOnRequest = false
    var retireOnHistory = false
    var requests: [OpenClawChatGatewayRequest] = []
    var delays: [Duration] = []
    var historyCalls = 0

    init(_ responses: [String]) {
        self.responses = responses
    }

    func request(_ request: OpenClawChatGatewayRequest) throws -> Data {
        self.requests.append(request)
        if self.retireOnRequest { self.current = false }
        guard !self.responses.isEmpty else { throw CancellationError() }
        let response = self.responses.removeFirst()
        if response == "transport-error" { throw URLError(.networkConnectionLost) }
        return Data(response.utf8)
    }

    func history() -> String {
        self.historyCalls += 1
        if self.retireOnHistory { self.current = false }
        return "The slow reply"
    }

    func pause(_ duration: Duration, retire: Bool = false) throws {
        self.delays.append(duration)
        if retire { self.current = false }
        if self.responses.isEmpty { throw CancellationError() }
    }

    func retireDuringRequest() { self.retireOnRequest = true }
    func retireDuringHistory() { self.retireOnHistory = true }
}

struct TalkModeRuntimeReplyTests {
    @Test func observesSlowGatewayRunAndReadsHistoryOnce() async {
        // Three 30-second observation timeouts exceed the old 45+12-second cutoff.
        let probe = TalkReplyProbe([
            #"{"status":"timeout"}"#, #"{"status":"timeout"}"#,
            #"{"status":"timeout"}"#, #"{"status":"ok"}"#,
        ])
        let reply = await Self.reply(probe)
        #expect(reply == "The slow reply")
        let requests = await probe.requests
        #expect(requests.count == 4)
        #expect(requests.allSatisfy {
            $0 == OpenClawChatGatewayRequests.agentWait(runID: "accepted-run", timeoutMs: 30000)
        })
        #expect(await probe.historyCalls == 1)
        #expect(await probe.delays == [.seconds(2), .seconds(2), .seconds(2)])
    }

    @Test func transientTransportFailureDoesNotAbandonAcceptedRun() async {
        let probe = TalkReplyProbe(["transport-error", #"{"status":"ok"}"#])
        #expect(await Self.reply(probe) == "The slow reply")
        #expect(await probe.historyCalls == 1)
        #expect(await probe.delays == [.seconds(30)])
    }

    @Test func terminalFailureNeverReadsHistory() async {
        let probe = TalkReplyProbe([#"{"status":"timeout","timeoutPhase":"provider"}"#])
        #expect(await Self.reply(probe) == nil)
        #expect(await probe.historyCalls == 0)
        #expect(await probe.delays.isEmpty)
    }

    @Test func retiredRouteOrLifecycleDiscardsCompletion() async {
        let probe = TalkReplyProbe([#"{"status":"ok"}"#])
        await probe.retireDuringRequest()
        #expect(await Self.reply(probe) == nil)
        #expect(await probe.historyCalls == 0)
    }

    @Test func retirementWhileReadingHistoryDiscardsText() async {
        let probe = TalkReplyProbe([#"{"status":"ok"}"#])
        await probe.retireDuringHistory()
        #expect(await Self.reply(probe) == nil)
        #expect(await probe.historyCalls == 1)
    }

    @Test func retirementDuringRetryDoesNotObserveAgain() async {
        let probe = TalkReplyProbe([#"{"status":"pending"}"#, #"{"status":"ok"}"#])
        let reply = await TalkModeRuntime.waitForAcceptedReply(
            runID: "accepted-run", request: { try await probe.request($0) },
            history: { await probe.history() }, isCurrent: { await probe.current },
            pause: { try await probe.pause($0, retire: true) })
        #expect(reply == nil)
        #expect(await probe.requests.count == 1)
        #expect(await probe.historyCalls == 0)
    }

    @Test func cancelledRetryDoesNotObserveAgain() async {
        let probe = TalkReplyProbe([#"{"status":"pending"}"#, #"{"status":"ok"}"#])
        let reply = await TalkModeRuntime.waitForAcceptedReply(
            runID: "accepted-run", request: { try await probe.request($0) },
            history: { await probe.history() }, isCurrent: { await probe.current },
            pause: { _ in throw CancellationError() })
        #expect(reply == nil)
        #expect(await probe.requests.count == 1)
        #expect(await probe.historyCalls == 0)
    }

    private static func reply(_ probe: TalkReplyProbe) async -> String? {
        await TalkModeRuntime.waitForAcceptedReply(
            runID: "accepted-run", request: { try await probe.request($0) },
            history: { await probe.history() }, isCurrent: { await probe.current },
            pause: { try await probe.pause($0) })
    }
}
