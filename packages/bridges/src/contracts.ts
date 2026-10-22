// What each bridge accepts, as plain data. The specs in specs.ts perform these; this module has no network code, so a
// browser extension's page script or a picker can read the registry without bundling a single request builder.
import type { CapabilityContract } from "@recast/core";

export const CONTRACTS = {
  googleCalendar: {
    destination: "google-calendar.event-editor", app: "Google Calendar", targetKind: "Event", reliability: "official-api", abilities: ["read", "update", "verify", "undo"],
    accepts: [
      { relationId: "person-event-attendee", effect: "Add attendee", effectFlags: ["notifies-third-party"], dataMoved: ["Person.name", "Person.email"] },
      { relationId: "location-event-location", effect: "Set location", dataMoved: ["Location.name", "Location.address"] },
    ],
  },
  googleCalendarEvent: {
    destination: "google-calendar.calendar", app: "Google Calendar", targetKind: "Calendar", reliability: "official-api", abilities: ["create", "read", "delete", "verify", "undo"],
    accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start", "Event.end", "Event.timezone", "Event.allDay", "Event.location"] }],
  },
  gmailDraft: {
    destination: "gmail.compose-draft", app: "Gmail", targetKind: "Message", reliability: "official-api", abilities: ["create", "delete", "undo"],
    accepts: [{ relationId: "person-message-recipient", effect: "Create a draft to this person", dataMoved: ["Person.email"] }],
  },
  gmailMessageDraft: {
    destination: "gmail.drafts", app: "Gmail", targetKind: "Drafts", reliability: "official-api", abilities: ["create", "delete", "undo"],
    accepts: [{ relationId: "message-draft-entry", effect: "Save as draft", dataMoved: ["Message.to", "Message.snippet"] }],
  },
  googleSheets: {
    destination: "google-sheets.range", app: "Google Sheets", targetKind: "Product", reliability: "official-api", abilities: ["create", "undo"],
    accepts: [{ relationId: "product-product-compare", effect: "Add a row", dataMoved: ["Product.name", "Product.url"] }],
  },
  googleTasks: {
    destination: "google-tasks.list", app: "Google Tasks", targetKind: "Task", reliability: "official-api", abilities: ["create", "delete", "undo"],
    accepts: [{ relationId: "document-task-reference", effect: "Add a task", dataMoved: ["Document.title", "Document.url"] }],
  },
  /** A whole task (a page with a due date) placed on the default list; `googleTasks` adds a document as a task. */
  googleTasksEntry: {
    destination: "google-tasks.tasklist", app: "Google Tasks", targetKind: "TaskList", reliability: "official-api", abilities: ["create", "delete", "undo"],
    accepts: [{ relationId: "task-tasklist-entry", effect: "Add a task", dataMoved: ["Task.title", "Task.url", "Task.due"] }],
  },
  notion: {
    destination: "notion.database", app: "Notion", targetKind: "Project", reliability: "official-api", abilities: ["create", "undo"],
    accepts: [{ relationId: "document-project-source", effect: "Add a page", dataMoved: ["Document.title", "Document.url"] }],
  },
  /** A note (passages with their sources) as a new Google Doc. Undo moves it to the Drive trash, where the person can still restore it. */
  googleDocs: {
    destination: "google-docs.new-document", app: "Google Docs", targetKind: "Docs", reliability: "official-api", abilities: ["create", "undo"],
    accepts: [{ relationId: "note-docs-entry", effect: "Create a document", dataMoved: ["Note.title", "Note.body"] }],
  },
  /**
   * An issue (an error, with notes) opened in one GitHub repository. Watchers may be notified, so it is confirmed first.
   * GitHub does not let ordinary accounts delete issues: Undo closes it as "not planned".
   */
  githubIssue: {
    destination: "github.issues", app: "GitHub", targetKind: "Issues", reliability: "official-api", abilities: ["create", "undo"],
    accepts: [{ relationId: "issue-tracker-entry", effect: "Open an issue", effectFlags: ["notifies-third-party"], dataMoved: ["Issue.title", "Issue.body"] }],
  },
  /** The same issue in Linear, on one team. Undo deletes it (Linear keeps deleted issues in its trash for a while). */
  linearIssue: {
    destination: "linear.issues", app: "Linear", targetKind: "Issues", reliability: "official-api", abilities: ["create", "delete", "undo"],
    accepts: [{ relationId: "issue-tracker-entry", effect: "Create an issue", effectFlags: ["notifies-third-party"], dataMoved: ["Issue.title", "Issue.body"] }],
  },
  // Open-and-prefill: the map app opens with directions to the place. Nothing is written, so there is nothing to confirm or undo.
  googleMaps: {
    destination: "google-maps.directions", app: "Google Maps", targetKind: "Map", reliability: "deep-link", abilities: ["open"],
    accepts: [{ relationId: "location-map-directions", effect: "Open directions", dataMoved: ["Location.name", "Location.address"] }],
  },
  appleMaps: {
    destination: "apple-maps.directions", app: "Apple Maps", targetKind: "Map", reliability: "deep-link", abilities: ["open"],
    accepts: [{ relationId: "location-map-directions", effect: "Open directions", dataMoved: ["Location.name", "Location.address"] }],
  },
} satisfies Record<string, CapabilityContract>;

/** Every destination Recast has a bridge for. Pickers list from here; nothing outside it is offered. */
export const REGISTRY: readonly CapabilityContract[] = Object.values(CONTRACTS);
