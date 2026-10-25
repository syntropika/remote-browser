// Native integration for the pinned CEF/Chromium build. See README.md.
#ifndef CEF_LIBCEF_BROWSER_REMOTE_BROWSER_INSTALL_BRIDGE_H_
#define CEF_LIBCEF_BROWSER_REMOTE_BROWSER_INSTALL_BRIDGE_H_

#include <memory>

#include "extensions/browser/extension_install_prompt_client.h"

namespace content {
class WebContents;
}
namespace extensions {
class InstallPromptData;
}

namespace remote_browser {

// Returns true when a windowless CEF prompt was handled, including refusal. Other
// browsers retain their existing behavior. A handled prompt consumes the callback
// and may transfer ownership of the permission data to the pending registry.
bool HandleInstallPrompt(
    content::WebContents* contents,
    std::unique_ptr<extensions::InstallPromptData>& prompt,
    extensions::ExtensionInstallPromptClient::DoneCallback& callback);

// Used to suppress Chrome's native post-install UI for windowless CEF contents.
bool IsWindowless(content::WebContents* contents);

}  // namespace remote_browser

#endif
