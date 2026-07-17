import { ScrollArea } from "@loopover/ui-kit/components/scroll-area";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { MessageBubble } from "./message-bubble";
import { TypingIndicator } from "./typing-indicator";
import type { ChatMessage } from "./fixtures";

// The scrollable message list for the chat rail (#6515). Backend-agnostic: it renders whatever message
// array it's given, wrapping the content in ui-kit's StateBoundary for its own loading/empty/error states
// and using ui-kit's ScrollArea (not a raw overflow div) for the viewport. The composing flag surfaces the
// TypingIndicator below the list regardless of the message-array state.
export function MessageList({
  messages,
  isLoading = false,
  isError = false,
  composing = false,
}: {
  messages: ChatMessage[];
  isLoading?: boolean;
  isError?: boolean;
  composing?: boolean;
}) {
  return (
    <ScrollArea className="h-full">
      <StateBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={messages.length === 0}
        loadingTitle="Loading conversation…"
        emptyTitle="No messages yet"
        emptyDescription="Start the conversation to see messages here."
        errorTitle="Couldn't load the conversation"
        errorDescription="The conversation source did not respond. Retry, or check back once it has recovered."
      >
        {/*
          #7081: the message list is a polite ARIA live region so assistive tech announces each completed turn
          even when the user has moved focus out of the list. `messages` gains a committed entry exactly once per
          turn — conversation.tsx appends the finished answer only after StreamingText's per-chunk accumulation
          resolves, never mid-stream, and the live StreamingText render lives OUTSIDE this list — so each new
          message announces once, never once-per-streaming-chunk. `aria-relevant="additions"` keeps it to newly
          appended messages; StateBoundary's own loading/empty/error status/alert regions are separate and
          untouched (an added message can't reach here in those branches anyway).
        */}
        <ol className="flex flex-col gap-4 p-3" aria-live="polite" aria-relevant="additions">
          {messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} />
            </li>
          ))}
        </ol>
      </StateBoundary>
      {composing ? <TypingIndicator composing authorName="Assistant" /> : null}
    </ScrollArea>
  );
}
