// The eve HTTP API listens only inside the sandbox VM (other sandboxes and the host are
// blocked from reaching it), and the platform authenticates callers before any turn
// reaches it. So the route accepts anonymous requests explicitly.
import { eveChannel } from "eve/channels/eve";
import { none } from "eve/channels/auth";

export default eveChannel({ auth: [none()] });
