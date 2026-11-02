// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  AssistantRuntimeProvider,
  MessagePrimitiveParts,
  ThreadPrimitiveMessages,
} from "@assistant-ui/core/react";
import type { HttpAgent } from "@ag-ui/client";
import { useAgUiRuntime } from "./useAgUiRuntime";

type Subscriber = Record<string, ((payload: any) => void) | undefined>;

const steppedAgent = () => {
  let subscriber!: Subscriber;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runAgent = vi.fn(async (_input: unknown, next: Subscriber) => {
    subscriber = next;
    await done;
  });
  return {
    agent: { runAgent, abortRun: vi.fn() } as unknown as HttpAgent,
    runAgent,
    send: (handler: string, event: Record<string, unknown>) =>
      subscriber[handler]?.({ event }),
    finish: () => finish(),
  };
};

const Thread = () => (
  <ThreadPrimitiveMessages
    components={{
      Message: () => (
        <MessagePrimitiveParts
          components={{
            Text: ({ text }) => <p>{text}</p>,
            Reasoning: ({ text }) => (
              <details data-testid="reasoning">
                <summary>Thinking</summary>
                {text}
              </details>
            ),
          }}
        />
      ),
    }}
  />
);

afterEach(() => {
  cleanup();
});

describe("useAgUiRuntime message identity", () => {
  it("keeps the assistant message mounted when text follows reasoning with a different id", async () => {
    const { agent, runAgent, send, finish } = steppedAgent();
    const { result } = renderHook(() => useAgUiRuntime({ agent }));
    render(
      <AssistantRuntimeProvider runtime={result.current}>
        <Thread />
      </AssistantRuntimeProvider>,
    );

    await act(async () => {
      await result.current.thread.append({
        role: "user",
        content: [{ type: "text", text: "why?" }],
      });
    });
    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    act(() => {
      send("onRunStartedEvent", { type: "RUN_STARTED", runId: "run-1" });
      send("onReasoningStartEvent", {
        type: "REASONING_START",
        messageId: "reasoning-1",
      });
      send("onReasoningMessageStartEvent", {
        type: "REASONING_MESSAGE_START",
        messageId: "reasoning-1",
      });
      send("onReasoningMessageContentEvent", {
        type: "REASONING_MESSAGE_CONTENT",
        messageId: "reasoning-1",
        delta: "Considering the question.",
      });
    });

    const details = await screen.findByTestId<HTMLDetailsElement>("reasoning");
    details.open = true;

    await act(async () => {
      send("onReasoningMessageEndEvent", {
        type: "REASONING_MESSAGE_END",
        messageId: "reasoning-1",
      });
      send("onReasoningEndEvent", {
        type: "REASONING_END",
        messageId: "reasoning-1",
      });
      send("onTextMessageStartEvent", {
        type: "TEXT_MESSAGE_START",
        messageId: "text-1",
        role: "assistant",
      });
      send("onTextMessageContentEvent", {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "text-1",
        delta: "Because.",
      });
      send("onTextMessageEndEvent", {
        type: "TEXT_MESSAGE_END",
        messageId: "text-1",
      });
      send("onRunFinishedEvent", { type: "RUN_FINISHED", runId: "run-1" });
      send("onRunFinalized", {});
      finish();
    });

    await waitFor(() =>
      expect(result.current.thread.getState().isRunning).toBe(false),
    );
    await screen.findByText("Because.");
    expect(result.current.thread.getState().messages.at(-1)?.id).toBe("text-1");
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(true);
    expect(screen.getByTestId("reasoning")).toBe(details);
  });
});
