// Default agent config for the agent-sandbox `eve` template.
import { defineAgent } from "eve";

export default defineAgent({
  // Through the Vercel AI Gateway; the sbx proxy supplies the key.
  model: "deepseek/deepseek-v4.1-flash",
  // The platform meters tokens itself; never pause a headless turn for a budget prompt.
  limits: { sessionUsage: false },
});
