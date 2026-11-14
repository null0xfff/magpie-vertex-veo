// Magpie & OpenCode provider plugin for Google Vertex AI Veo video
// generation. Only the plugin itself is exported here: the host calls every
// function a plugin's entry exports as a plugin. The factory and the pieces
// behind it live in ./lib.

import { createVertexVeoPlugin } from "./lib/plugin.mjs"

export const VertexVeoPlugin = createVertexVeoPlugin()
export default VertexVeoPlugin
