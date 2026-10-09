//! Browser-side inspection program; native WebDriver references preserve element identity.
pub const SCRIPT: &str = r#"
// Execute inside the current document. WebDriver serializes element identity natively.
const limit = arguments[0];
const elements = [];
let visited = 0;
let truncated = false;
const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const visible = (element) => {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
};
const name = (element) => {
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
    if (text.trim()) return clean(text, 160);
  }
  const label = element.getAttribute("aria-label");
  if (label) return clean(label, 160);
  if (element.labels?.length) return clean(Array.from(element.labels).map((label) => label.textContent).join(" "), 160);
  // Values, including passwords and text inputs, are deliberately excluded.
  return clean(element.getAttribute("alt") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("title"), 160);
};
const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
let element = walker.currentNode;
while (element) {
  if (++visited > 3000) { truncated = true; break; }
  const tag = element.localName;
  const role = element.getAttribute("role") || ({a:"link",button:"button",textarea:"textbox",select:"combobox",input:({checkbox:"checkbox",radio:"radio",button:"button",submit:"button",range:"slider"}[element.type] || "textbox")}[tag]);
  const interactive = role || element.isContentEditable || element.tabIndex >= 0;
  if (interactive && tag !== "iframe" && visible(element)) {
    if (elements.length >= limit) { truncated = true; break; }
    elements.push({ element, role: role || "element", name: name(element), tag, type: element.getAttribute("type"), disabled: !!element.disabled });
  }
  element = walker.nextNode();
}
const text = document.body?.innerText || "";
return { url: location.href, title: document.title, text: text.slice(0, 12000), truncated: truncated || text.length > 12000, elements };
"#;
