import { setupServer } from "msw/node";
import { http, HttpResponse, delay } from "msw";

interface SessionState {
  step: number;
  request_id: string;
}

const sessions = new Map<string, SessionState>();

export function resetMockOrchestrator() {
  sessions.clear();
}

export const orchestratorHandlers = [
  http.get("http://orchestrator.test/health", () =>
    HttpResponse.json({ status: "ok" })
  ),
  http.post("http://orchestrator.test/handoff", async ({ request }) => {
    const body = (await request.json()) as { request_id?: string };
    const reqId = body.request_id ?? "REQ-2024-9999";
    const handoffId = `handoff-${reqId}`;
    sessions.set(handoffId, { step: 0, request_id: reqId });
    return HttpResponse.json({
      request_id: reqId,
      status: "queued",
      handoff_id: handoffId
    });
  }),
  http.get("http://orchestrator.test/handoff/:id/status", async ({ params }) => {
    const handoffId = String(params.id);
    let session = sessions.get(handoffId);
    if (!session) {
      session = { step: 0, request_id: handoffId };
      sessions.set(handoffId, session);
    }
    const reqId = session.request_id;
    const stepNow = session.step;
    if (session.step < 3) session.step += 1;

    await delay(2);
    switch (stepNow) {
      case 0:
        return HttpResponse.json({ request_id: reqId, status: "queued" });
      case 1:
        return HttpResponse.json({ request_id: reqId, status: "prefilled" });
      case 2:
        return HttpResponse.json({
          request_id: reqId,
          status: "ready",
          window_title: "Zava Mutual — Claims Workstation v1.0",
          matched_policy_number: "POL-2024-008341",
          matched_customer_name: "Jordan Smith"
        });
      default:
        return HttpResponse.json({
          request_id: reqId,
          status: "submitted",
          claim_id: "CLM-2024-000777",
          policy_number: "POL-2024-008341",
          agent_id: "C1001",
          reserve_amount: 4200
        });
    }
  })
];

export const orchestratorServer = setupServer(...orchestratorHandlers);
