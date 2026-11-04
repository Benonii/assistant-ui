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
type Send = (handler: string, event: Record<string, unknown>) => void;

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
    send: ((handler, event) => subscriber[handler]?.({ event })) as Send,
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

const snapshot = (send: Send, userId: string) =>
  send("onMessagesSnapshotEvent", {
    type: "MESSAGES_SNAPSHOT",
    messages: [
      { id: userId, role: "user", content: "why?" },
      {
        id: "reasoning-1",
        role: "reasoning",
        content: "Considering the question.",
      },
      { id: "assistant-1", role: "assistant", content: "Because." },
    ],
  });

const runFinished = (send: Send) =>
  send("onRunFinishedEvent", { type: "RUN_FINISHED", runId: "run-1" });

const orders: [string, (send: Send, userId: string) => void][] = [
  [
    "before RUN_FINISHED",
    (send, userId) => {
      snapshot(send, userId);
      runFinished(send);
    },
  ],
  [
    "after RUN_FINISHED",
    (send, userId) => {
      runFinished(send);
      snapshot(send, userId);
    },
  ],
];

afterEach(() => {
  cleanup();
});

describe("useAgUiRuntime snapshot after reasoning (repro #10229 case 4)", () => {
  it.each(orders)(
    "shows one assistant message when the snapshot arrives %s",
    async (_label, endRun) => {
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
      const userId = result.current.thread.getState().messages[0]!.id;

      await act(async () => {
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
        send("onReasoningMessageEndEvent", {
          type: "REASONING_MESSAGE_END",
          messageId: "reasoning-1",
        });
        send("onReasoningEndEvent", {
          type: "REASONING_END",
          messageId: "reasoning-1",
        });
        endRun(send, userId);
        send("onRunFinalized", {});
        finish();
      });

      await waitFor(() =>
        expect(result.current.thread.getState().isRunning).toBe(false),
      );
      const messages = result.current.thread.getState().messages;
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1]!.id).toBe("assistant-1");
      expect(screen.getAllByTestId("reasoning")).toHaveLength(1);
    },
  );
});
