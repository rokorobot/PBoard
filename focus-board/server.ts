import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Frontend-only plugin: all data comes from the host's live sidebar thread view.
export default function plugin(bb: BbPluginApi) {
  bb.log.info("focus-board loaded");
}
