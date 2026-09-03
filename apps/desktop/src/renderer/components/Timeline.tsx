import {
  formatEventTitle,
  formatRunEventDetail
} from "@lecoding/presentation";
import type { RunConsoleState } from "@lecoding/run-controller";

/** Console snapshot whose durable Run events are rendered as plain text. */
export interface TimelineProps {
  state: RunConsoleState;
}

/**
 * Durable event timeline.
 *
 * Every string is rendered as a React text node, so model-authored summaries
 * and command text can never become markup.
 */
export function Timeline({ state }: TimelineProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Timeline</p>
          <h3>执行时间线</h3>
        </div>
        <span className="chip">{state.timeline.length} 个事件</span>
      </div>
      {state.timeline.length === 0 ? (
        <p className="empty-state">还没有事件；Run 开始后会实时追加。</p>
      ) : (
        <ol className="timeline">
          {state.timeline.map((event) => (
            <li
              key={`${event.runId}-${event.sequence}`}
              className="timeline-item"
              data-event-type={event.type}
            >
              <span className="timeline-marker" />
              <div className="timeline-content">
                <strong>{formatEventTitle(event.type)}</strong>
                <span>{formatRunEventDetail(event)}</span>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleTimeString("zh-CN", {
                    hour12: false
                  })}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
