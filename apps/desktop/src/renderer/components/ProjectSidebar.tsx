import type { RunConsoleController } from "@lecoding/run-controller";

export interface ProjectSidebarProps {
  controller: RunConsoleController;
  projectIds: string[];
  selectedProjectId: string | undefined;
  roleLabel: string;
}

/**
 * Project picker.
 *
 * A single registered project stays visible but disabled: showing a select
 * with one entry would imply a choice that does not exist.
 */
export function ProjectSidebar({
  controller,
  projectIds,
  selectedProjectId,
  roleLabel
}: ProjectSidebarProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Project</p>
          <h3>当前项目</h3>
        </div>
        <span className="chip">{roleLabel}</span>
      </div>
      <div className="field">
        <label htmlFor="project-select">项目</label>
        <select
          id="project-select"
          value={selectedProjectId ?? ""}
          disabled={projectIds.length <= 1}
          onChange={(event) => {
            void controller.selectProject(event.target.value);
          }}
        >
          {projectIds.length === 0 ? <option value="">没有可用项目</option> : null}
          {projectIds.map((projectId) => (
            <option key={projectId} value={projectId}>
              {projectId}
            </option>
          ))}
        </select>
        <small>切换项目会断开当前 Run 的实时连接并重新加载历史。</small>
      </div>
    </section>
  );
}
