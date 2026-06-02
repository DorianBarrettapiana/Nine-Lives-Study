/**
 * Small post-reading ritual shown after a timer completes a paper-backed task.
 */

import { createPaperInsight, getReadingContext } from "../api/notes";
import { createDailyTask } from "../api/tracker";
import { escapeHtml, setMessage } from "../utils";

let promptOpen = false;
let initialized = false;

async function showPrompt(taskId: number): Promise<void> {
  if (promptOpen) return;
  const context = await getReadingContext(taskId);
  if (context === null) return;
  promptOpen = true;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal-card modal-wide reading-insight-modal">
      <h3>Capture a reading insight</h3>
      <p class="hint">You just focused on <strong>${escapeHtml(context.title)}</strong>. Keep the useful residue before moving on.</p>
      <label>One useful idea
        <textarea id="reading-insight-idea" placeholder="What changed or sharpened your understanding?"></textarea>
      </label>
      <label>One open question
        <textarea id="reading-insight-question" placeholder="What remains unclear or worth challenging?"></textarea>
      </label>
      <label>One next step
        <input id="reading-insight-next" type="text" placeholder="e.g. Compare the ablation table with our baseline" />
      </label>
      <label class="checkbox-row">
        <input id="reading-insight-add-task" type="checkbox" checked />
        Add the next step to today's tasks
      </label>
      <p id="reading-insight-message" class="message"></p>
      <div class="modal-actions">
        <button type="button" class="secondary" data-reading-action="skip">Skip</button>
        <button type="submit">Save insight</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);

  const form = backdrop.querySelector<HTMLFormElement>("form")!;
  const idea = backdrop.querySelector<HTMLTextAreaElement>("#reading-insight-idea")!;
  const question = backdrop.querySelector<HTMLTextAreaElement>("#reading-insight-question")!;
  const nextStep = backdrop.querySelector<HTMLInputElement>("#reading-insight-next")!;
  const addTask = backdrop.querySelector<HTMLInputElement>("#reading-insight-add-task")!;
  const message = backdrop.querySelector<HTMLParagraphElement>("#reading-insight-message")!;

  const close = (): void => {
    promptOpen = false;
    backdrop.remove();
  };
  backdrop.addEventListener("click", (event) => {
    const target = event.target;
    if (target === backdrop) close();
    if (target instanceof HTMLElement && target.dataset.readingAction === "skip") close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      key_idea: idea.value.trim(),
      question: question.value.trim(),
      next_step: nextStep.value.trim(),
    };
    if (!payload.key_idea && !payload.question && !payload.next_step) {
      setMessage(message, "Add at least one idea, question, or next step.", "error");
      return;
    }
    try {
      await createPaperInsight(context.note_id, payload);
      if (payload.next_step && addTask.checked) {
        await createDailyTask({ text: payload.next_step, project_id: context.project_id });
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      }
      window.dispatchEvent(new CustomEvent("paper-insights:updated"));
      close();
    } catch (error) {
      console.error(error);
      setMessage(message, "Could not save reading insight.", "error");
    }
  });
  idea.focus();
}

export function initReadingInsightPrompts(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("reading-focus:completed", (event) => {
    const detail = (event as CustomEvent<{ linkedTaskId: number | null }>).detail;
    if (detail?.linkedTaskId !== null && detail?.linkedTaskId !== undefined) {
      void showPrompt(detail.linkedTaskId);
    }
  });
}
