// Compatibility endpoint for API consumers. The direct-to-Blob architecture uses
// this as upload authorization; callers must then PUT to uploadUrl and call /complete.
export { POST } from "./init/route";
