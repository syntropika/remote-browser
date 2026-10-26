#include "cef/libcef/browser/remote_browser_extension_management_capi.h"

#include <algorithm>
#include <cstring>
#include <string>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "cef/libcef/browser/browser_host_base.h"
#include "content/public/browser/browser_thread.h"
#include "extensions/browser/disable_reason.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/browser/extension_registrar.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_system.h"
#include "extensions/browser/management_policy.h"
#include "extensions/browser/uninstall_reason.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest.h"
#include "extensions/common/manifest_handlers/description_info.h"
#include "extensions/common/manifest_handlers/options_page_info.h"

namespace {
constexpr size_t kCapacity = 1024 * 1024;

base::DictValue Error(const std::string& message) {
  base::DictValue result;
  result.Set("error", message);
  return result;
}

bool Visible(const extensions::Extension& extension) {
  return extension.is_extension() &&
         !extensions::Manifest::IsComponentLocation(extension.location());
}

bool MayEnable(content::BrowserContext* context,
               const extensions::Extension& extension,
               const extensions::ManagementPolicy* policy) {
  auto* prefs = extensions::ExtensionPrefs::Get(context);
  if (!policy->UserMayModifySettings(&extension, nullptr) ||
      policy->MustRemainDisabled(&extension, nullptr) ||
      prefs->DidExtensionEscalatePermissions(extension.id())) {
    return false;
  }
  // Re-enabling after a permissions increase, blocklist verdict or unmet native
  // requirement needs Chromium's own review flow. Only undo an ordinary user disable.
  const auto reasons = prefs->GetDisableReasons(extension.id());
  return std::all_of(reasons.begin(), reasons.end(), [](auto reason) {
    return reason == extensions::disable_reason::DISABLE_USER_ACTION;
  });
}

base::DictValue Execute(int browser_id, const base::DictValue& request) {
  auto browser = CefBrowserHostBase::GetBrowserForBrowserId(browser_id);
  if (!browser || !browser->GetWebContents()) {
    return Error("The browser session is no longer available");
  }
  auto* context = browser->GetBrowserContext();
  auto* registry = extensions::ExtensionRegistry::Get(context);
  auto* system = extensions::ExtensionSystem::Get(context);
  if (!registry || !system || !system->management_policy()) {
    return Error("Extension management is unavailable in this browser session");
  }
  auto* policy = system->management_policy();
  const auto* operation = request.FindString("op");
  if (!operation) {
    return Error("An extension operation is required");
  }
  if (*operation == "list") {
    base::ListValue values;
    for (const auto& extension : registry->GenerateInstalledExtensionsSet()) {
      if (!Visible(*extension)) {
        continue;
      }
      if (values.size() >= 256) {
        return Error("Too many extensions to display; the maximum is 256");
      }
      const bool enabled = registry->enabled_extensions().Contains(extension->id());
      const bool may_modify = policy->UserMayModifySettings(extension.get(), nullptr);
      base::DictValue value;
      value.Set("id", extension->id());
      value.Set("name", std::string(base::TruncateUTF8ToByteSize(extension->name(), 256)));
      value.Set("version", extension->VersionString());
      value.Set("description", std::string(base::TruncateUTF8ToByteSize(extensions::DescriptionInfo::GetDescription(*extension), 2048)));
      value.Set("enabled", enabled);
      value.Set("mayEnable", MayEnable(context, *extension, policy));
      value.Set("mayDisable", may_modify && !policy->MustRemainEnabled(extension.get(), nullptr));
      value.Set("mayRemove", may_modify && !policy->MustRemainInstalled(extension.get(), nullptr));
      value.Set("hasOptions", extensions::OptionsPageInfo::GetOptionsPage(extension.get()).is_valid());
      values.Append(std::move(value));
    }
    base::DictValue result;
    result.Set("available", true);
    result.Set("extensions", std::move(values));
    return result;
  }

  const auto* id = request.FindString("id");
  if (!id || id->size() != 32 || !std::all_of(id->begin(), id->end(), [](char c) {
        return c >= 'a' && c <= 'p';
      })) {
    return Error("A valid extension ID is required");
  }
  const auto* extension = registry->GetExtensionById(*id, extensions::ExtensionRegistry::EVERYTHING);
  if (!extension || !Visible(*extension)) {
    return Error("This extension is no longer installed in this session");
  }
  if (*operation == "options") {
    const auto& url = extensions::OptionsPageInfo::GetOptionsPage(extension);
    if (!registry->enabled_extensions().Contains(*id) || !url.is_valid()) {
      return Error("Enable this extension before opening its available options");
    }
    base::DictValue result;
    result.Set("url", url.spec());
    return result;
  }
  if (!policy->UserMayModifySettings(extension, nullptr)) {
    return Error("Browser policy does not allow changing this extension");
  }
  auto* registrar = extensions::ExtensionRegistrar::Get(context);
  if (!registrar) {
    return Error("Extension management is not ready; try again");
  }
  if (*operation == "set_enabled") {
    const auto enabled = request.FindBool("enabled");
    if (!enabled.has_value()) {
      return Error("An explicit enabled state is required");
    }
    if (*enabled) {
      if (!MayEnable(context, *extension, policy)) {
        return Error("Chromium requires a policy or permissions review before enabling this extension");
      }
      registrar->EnableExtension(*id);
    } else {
      if (policy->MustRemainEnabled(extension, nullptr)) {
        return Error("Browser policy requires this extension to remain enabled");
      }
      registrar->DisableExtension(*id, {extensions::disable_reason::DISABLE_USER_ACTION});
    }
    if (registry->enabled_extensions().Contains(*id) != *enabled) {
      return Error("Chromium did not apply the requested state; refresh and try again");
    }
  } else if (*operation == "remove") {
    if (request.FindBool("confirmed") != true) {
      return Error("Confirm removal of this extension first");
    }
    if (policy->MustRemainInstalled(extension, nullptr)) {
      return Error("Browser policy requires this extension to remain installed");
    }
    std::u16string error;
    if (!registrar->UninstallExtension(*id, extensions::UNINSTALL_REASON_USER_INITIATED, &error)) {
      return Error(error.empty() ? "Chromium could not remove this extension" : base::UTF16ToUTF8(error));
    }
  } else {
    return Error("Unknown extension operation");
  }
  base::DictValue result;
  result.Set("ok", true);
  return result;
}
}  // namespace

size_t rb_extensions_manage_v1(int browser_id, const char* request, char* data, size_t capacity) {
  if (!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI) ||
      !request || !data || capacity < kCapacity || strnlen(request, 4097) > 4096) {
    return 0;
  }
  auto parsed = base::JSONReader::Read(request, base::JSON_PARSE_RFC);
  auto result = parsed && parsed->is_dict()
                    ? Execute(browser_id, parsed->GetDict())
                    : Error("The extension request is invalid");
  std::string json;
  if (!base::JSONWriter::Write(result, &json) || json.size() > capacity) {
    return 0;
  }
  std::memcpy(data, json.data(), json.size());
  return json.size();
}
