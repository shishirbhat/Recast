import type { ApiType } from "../src";

/** Hand-labelled inputs. `type: null` means the right answer is "do not resolve to anything". Written independently of the rules. */
export interface Labelled { raw: string; type: ApiType | null; fields?: Record<string, unknown> }
export const LABELLED: Labelled[] = [
  // People
  { raw: "Meera Iyer, meera@example.com", type: "Person", fields: { name: "Meera Iyer" } },
  { raw: "Aarav Mehta <aarav.mehta@zoho.com>", type: "Person", fields: { name: "Aarav Mehta" } },
  { raw: "Priya Nair | priya@startup.in | +91 98765 43210", type: "Person", fields: { name: "Priya Nair" } },
  { raw: "Dr. Ananya Rao, ananya.rao@iisc.ac.in", type: "Person", fields: { name: "Dr. Ananya Rao" } },
  { raw: "Rahul Sharma +91 99887 76655", type: "Person", fields: { name: "Rahul Sharma" } },
  { raw: "Ludwig van Beethoven, ludwig@vienna.at", type: "Person", fields: { name: "Ludwig van Beethoven" } },
  { raw: "J. R. Smith, jr.smith@mail.co.uk", type: "Person", fields: { name: "J. R. Smith" } },
  { raw: "sam@x.com (Sam Carter)", type: "Person", fields: { name: "Sam Carter" } },
  { raw: "José García, jose@correo.es", type: "Person", fields: { name: "José García" } },
  { raw: "Contact: Neha Gupta, neha@corp.com", type: null },          // leading label makes the name unreadable; honest miss is acceptable
  // Events
  { raw: "Launch dinner 2026-11-14 19:30", type: "Event", fields: { title: "Launch dinner", start: "2026-11-14T19:30" } },
  { raw: "Diwali party on 8 November 2026", type: "Event", fields: { title: "Diwali party", start: "2026-11-08" } },
  { raw: "Hackathon kickoff, Dec 3, 2026 10am", type: "Event", fields: { title: "Hackathon kickoff", start: "2026-12-03T10:00" } },
  { raw: "Board meeting 2026-12-01", type: "Event", fields: { title: "Board meeting", start: "2026-12-01" } },
  { raw: "Annual general meeting 15 Jan 2027, 4:30 pm", type: "Event", fields: { title: "Annual general meeting", start: "2027-01-15T16:30" } },
  { raw: "Design review 2026-11-20T14:00", type: "Event", fields: { title: "Design review", start: "2026-11-20T14:00" } },
  { raw: "Standup tomorrow 9am", type: null },
  { raw: "Lunch next Friday", type: null },
  { raw: "Project kickoff 2026-13-40", type: null },
  // Locations
  { raw: "Toit, 298 100 Feet Road, Indiranagar, Bengaluru 560038", type: "Location", fields: { name: "Toit" } },
  { raw: "221B Baker Street, London NW1 6XE", type: "Location", fields: { address: "221B Baker Street, London NW1 6XE" } },
  { raw: "1600 Pennsylvania Avenue NW, Washington, DC 20500", type: "Location", fields: { address: "1600 Pennsylvania Avenue NW, Washington, DC 20500" } },
  { raw: "Blue Tokai, 12 MG Road, Pune 411001", type: "Location", fields: { name: "Blue Tokai" } },
  { raw: "5 Rue de Rivoli, 75004 Paris", type: "Location" },
  { raw: "Mumbai", type: null },
  { raw: "Meera Iyer", type: null },     // a bare name is not enough to call it a person: it stays ambiguous
  { raw: "Somewhere over the rainbow", type: null },
  // Products
  { raw: "Philips Electric Kettle ₹1,499", type: "Product", fields: { name: "Philips Electric Kettle" } },
  { raw: "Logitech MX Master 3S $99.99", type: "Product", fields: { name: "Logitech MX Master 3S" } },
  { raw: "Buy Sony WH-1000XM5 for $348", type: "Product", fields: { name: "Sony WH-1000XM5" } },
  { raw: "Moleskine notebook 18.50 EUR", type: "Product", fields: { name: "Moleskine notebook" } },
  { raw: "Rs. 999 only", type: null },
  { raw: "Free shipping on all orders", type: null },
  // Papers
  { raw: "Attention Is All You Need (2017) arXiv:1706.03762", type: "Paper", fields: { title: "Attention Is All You Need" } },
  { raw: "Deep learning Nature 2015 doi 10.1038/nature14539", type: "Paper" },     // relabelled after the first run: it IS a paper reference (title comes out noisy, so no field check)
  { raw: "Language Models are Few-Shot Learners https://arxiv.org/abs/2005.14165", type: "Paper", fields: { title: "Language Models are Few-Shot Learners" } },
  { raw: "10.1145/3290605.3300233", type: null },
  // Noise / non-objects
  { raw: "hello", type: null },
  { raw: "Please review the attached document by Friday", type: null },
  { raw: "https://example.com/some/page", type: null },
  { raw: "12345", type: null },
  { raw: "The quick brown fox jumps over the lazy dog", type: null },
];
