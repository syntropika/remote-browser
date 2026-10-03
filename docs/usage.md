# Using Remote Browser

## Account setup

Open <http://localhost:8080>. On first access, choose a username and a password of at least 12 characters. Creating the account closes first-time registration. Later visits use that username and password; no dashboard token is needed.

Setup includes **Generate password**, which creates a random 24-character password in your browser and fills both password fields. Save it in your password manager before continuing. The form also provides native password-manager hints, but automatic suggestions and saving depend on the browser and password-manager settings.

The account is stored in `/data/account.json` with a salted scrypt password hash, not the password itself. Dashboard sessions use an eight-hour HttpOnly, SameSite cookie; passwords are not stored in local storage. Complete initial setup from a trusted device before giving others access to the service.

## Sharing control with an agent

Use **Take control** to sign in to a website, then **Return to agent**. The observation connection is enforced as read-only by a separate VNC server. Human ownership expires after 90 seconds without renewal; the dashboard renews it while connected. If another tool is already running, human takeover enters a pending state and waits for completion.

When an agent calls **browser_execute** during human control, the connected control owner's dashboard immediately shows a five-second popup. **Cancel · Keep control** or Escape cancels that execution and keeps the human lease. New agent prompts are suppressed for 30 seconds after cancellation, or until control is returned. Without cancellation, the same MCP call continues automatically: the server revokes interactive VNC input, waits for any current native action to finish, then reserves control for that agent operation. Other agent calls cannot run concurrently. A disconnected or revoked requesting client cancels a pending handoff. The control owner's dashboard must be connected to receive the prompt; losing its notification connection cancels the pending request. Documentation and discovery do not request control.

## Desktop and mobile controls

On desktop, the remote display fills the window. One floating bottom dock contains back, forward, reload, the address field, tabs, **Take control** or **Return to agent**, and **More options**. Tabs and More options open upward above the dock. The display fits automatically; desktop uses your physical keyboard directly and has no Zoom or Keyboard buttons. On phones, the address, history, tabs, zoom and control ownership actions sit in the top toolbar. Zoom and ownership use plain icons with 44px touch targets and accessible labels. A native keyboard input with an adjacent **Enter** action stays visible at the bottom. **More options** contains the Files gallery, API key management, clipboard, reconnect and sign-out actions, plus ownership and connection text on both layouts.

After taking control, tap the address field to use the device's native keyboard. Enter a web address or search query; searches use Google, and addresses without a scheme default to HTTPS. The tab list can open, switch and close tabs in the same persistent Chromium session. Back, forward and reload also act on that session. Closing the final tab creates a blank replacement so the browser remains running.

To type into a page on desktop, take control, click its field in the remote display, and type on your physical keyboard. On mobile, take control and tap the remote field first, then tap the local input at the bottom. Focusing that input activates the bridge only while the interactive connection has human control. The mobile input stays visible but disabled while observing, and the layout never focuses it automatically. **Enter** sits beside the input, and a dismiss action appears on focus. Use the native keyboard to delete text.

The mobile input forwards text, pasted text and composed characters through the interactive VNC connection. It clears committed text immediately and is wiped when control ends or the connection is lost. Dismissing the keyboard leaves the mobile input visible. The streamed display is a canvas, so tapping a remote field alone cannot identify that field to iOS or automatically open its keyboard.

For clipboard transfers, take control and open **More options → Clipboard**. Select text in the remote browser, then choose **Copy from browser** and **Copy to device**. To paste, focus the remote field first, paste into the panel's text area using your device's native paste action, then choose **Paste in browser**. Unicode text, including emoji, uses the desktop clipboard directly; transfers are limited to 64 KiB. The panel clears when closed or when control or the connection ends. Clipboard contents are not stored by the gateway. Copying to the device has an HTTP-compatible fallback; if the device blocks it, the text remains selected for its native Copy action. Images and files are not supported by this text bridge.

In the fitted mobile view, swipe with one finger to scroll the page and tap to click. **Zoom** switches to actual-size viewing: drag with one finger to pan the display, or use two fingers to scroll the page. Use **Fit** to return to the fitted view. Switching to the desktop layout also restores the fitted view. Native navigation, tabs, scrolling, and keyboard input require the human control lease. An unfinished native browser operation keeps MCP input blocked even if its owner releases control before the operation completes.

## Files and API keys

Open **More options → Files** to preview screenshots, play recordings, download saved files or upload a document for an agent. Deletion requires confirmation. Open **More options → API keys** to create or revoke named keys for MCP clients. Neither panel requires taking browser control.

See [MCP and agent automation](mcp.md) for file operations, quotas and key behavior, and [hosting and persistence](hosting.md) for keeping account and website sessions across updates.
