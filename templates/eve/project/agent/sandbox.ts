import { defineSandbox } from "eve/sandbox";
import { LocalSandbox } from "./lib/local-sandbox";

export const environment = LocalSandbox.environment();
export default defineSandbox(() => environment.open());
