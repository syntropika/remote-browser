// Versioned extension management for the browser-process UI thread.
#ifndef CEF_LIBCEF_BROWSER_REMOTE_BROWSER_EXTENSION_MANAGEMENT_CAPI_H_
#define CEF_LIBCEF_BROWSER_REMOTE_BROWSER_EXTENSION_MANAGEMENT_CAPI_H_

#include <stddef.h>
#include "cef/include/internal/cef_export.h"

#ifdef __cplusplus
extern "C" {
#endif

// Executes one JSON request for the context owning browser_id. Supported operations:
// list; set_enabled with id and an explicit enabled boolean; remove with id and
// confirmed:true; options with id. Component extensions are never exposed or modified. Chromium
// policy and permission-increase restrictions remain authoritative.
//
// request is borrowed NUL-terminated UTF-8 (at most 4096 bytes). data must be writable
// for capacity bytes, with capacity >= 1 MiB; otherwise nothing is executed. Returns
// the UTF-8 response length without a NUL, or zero for an invalid thread/buffer or
// serialization failure. There is no size-query mode: never repeat a mutation to
// determine response size. All pointers are borrowed only for this call.
CEF_EXPORT size_t rb_extensions_manage_v1(int browser_id,
                                         const char* request,
                                         char* data,
                                         size_t capacity);

#ifdef __cplusplus
}
#endif
#endif
