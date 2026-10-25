// Independent C ABI exported by the custom CEF library.
#ifndef CEF_LIBCEF_BROWSER_REMOTE_BROWSER_INSTALL_BRIDGE_CAPI_H_
#define CEF_LIBCEF_BROWSER_REMOTE_BROWSER_INSTALL_BRIDGE_CAPI_H_

#include <stddef.h>

#include "cef/include/internal/cef_export.h"

#ifdef __cplusplus
extern "C" {
#endif

// All calls run on the browser-process UI thread after CEF initialization and
// before shutdown. Names define the v1 ABI; breaking changes require new names.

// Enables explicit decisions and returns 1. Returns 0 on another thread.
CEF_EXPORT int rb_extension_install_enable_v1(void);

// Returns the required UTF-8 JSON byte count, without a NUL terminator. Writes only
// when data is non-null and capacity holds the entire response. Retains no pointer.
// Returns 0 on another thread or a serialization failure.
CEF_EXPORT size_t rb_extension_install_poll_v1(char* data, size_t capacity);

// Returns 1 only when an unexpired request for this browser was consumed. An allow
// decision authorizes the native installer; it does not report installation success.
// Returns 0 for an invalid/stale request, another thread, or an invalid allow value.
// id must be a borrowed NUL-terminated token from poll, valid for the entire call.
CEF_EXPORT int rb_extension_install_resolve_v1(const char* id,
                                              int browser_id,
                                              int allow);

// Aborts unresolved decisions for one browser, or all browsers when browser_id is 0.
// Does not roll back a consumed approval or a completed installation. A call from
// another thread has no effect.
CEF_EXPORT void rb_extension_install_cancel_v1(int browser_id);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif
