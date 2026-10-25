#include "cef/libcef/browser/remote_browser_install_bridge.h"

#include "cef/libcef/browser/remote_browser_install_bridge_capi.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/unguessable_token.h"
#include "base/values.h"
#include "cef/libcef/browser/browser_host_base.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "extensions/browser/install_prompt_data.h"

namespace {

using Client = extensions::ExtensionInstallPromptClient;
constexpr auto kDecisionTimeout = base::Minutes(3);
constexpr size_t kMaximumPending = 32;

// Retains the native callback and immutable permission data until a single decision
// or an abort. The original native installer still validates the downloaded package.
class Pending : public content::WebContentsObserver {
 public:
  Pending(content::WebContents* contents,
          int browser_id,
          std::unique_ptr<extensions::InstallPromptData> prompt,
          Client::DoneCallback callback)
      : content::WebContentsObserver(contents),
        browser_id_(browser_id),
        origin_(contents->GetPrimaryMainFrame()->GetLastCommittedOrigin().Serialize()),
        deadline_(base::TimeTicks::Now() + kDecisionTimeout),
        prompt_(std::move(prompt)),
        callback_(std::move(callback)) {
    timer_.Start(FROM_HERE, kDecisionTimeout,
                 base::BindOnce(&Pending::Abort, base::Unretained(this)));
    prompt_->OnDialogOpened();
  }

  ~Pending() override { Abort(); }

  bool active() const { return !callback_.is_null(); }
  int browser_id() const { return browser_id_; }

  base::DictValue Describe(const std::string& id) const {
    base::DictValue value;
    value.Set("id", id);
    value.Set("browserId", browser_id_);
    value.Set("extensionId", prompt_->extension()->id());
    value.Set("name", prompt_->extension()->name());
    value.Set("version", prompt_->extension()->version().GetString());
    value.Set("origin", origin_);
    base::ListValue permissions;
    const auto warnings = prompt_->GetPermissions();
    for (size_t i = 0; i < warnings.permissions.size(); ++i) {
      auto warning = base::UTF16ToUTF8(warnings.permissions[i]);
      if (i < warnings.details.size() && !warnings.details[i].empty()) {
        warning += "\n" + base::UTF16ToUTF8(warnings.details[i]);
      }
      permissions.Append(std::move(warning));
    }
    value.Set("permissions", std::move(permissions));
    value.Set("secondsRemaining", static_cast<int>(std::max<int64_t>(
        0, (deadline_ - base::TimeTicks::Now()).InSeconds())));
    return value;
  }

  bool Resolve(bool allow) {
    if (!active() || !web_contents() ||
        deadline_ <= base::TimeTicks::Now() ||
        web_contents()->GetPrimaryMainFrame()->GetLastCommittedOrigin().Serialize() != origin_) {
      Abort();
      return false;
    }
    const auto result = allow
        ? (prompt_->ShouldWithheldPermissionsOnDialogAccept()
               ? Client::Result::ACCEPTED_WITH_WITHHELD_PERMISSIONS
               : Client::Result::ACCEPTED)
        : Client::Result::USER_CANCELED;
    Complete(result);
    return true;
  }

  void Abort() { Complete(Client::Result::ABORTED); }

 private:
  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame() && !navigation->IsSameDocument()) {
      Abort();
    }
  }

  void WebContentsDestroyed() override { Abort(); }

  void Complete(Client::Result result) {
    if (!active()) {
      return;
    }
    timer_.Stop();
    Observe(nullptr);
    auto callback = std::move(callback_);
    if (result == Client::Result::ACCEPTED ||
        result == Client::Result::ACCEPTED_WITH_WITHHELD_PERMISSIONS) {
      prompt_->OnDialogAccepted();
    } else {
      prompt_->OnDialogCanceled();
    }
    // Keep this observer alive until the next registry prune: a navigation or
    // destruction notification may still be on the stack when the callback runs.
    std::move(callback).Run(Client::DoneCallbackPayload(result));
  }

  const int browser_id_;
  const std::string origin_;
  const base::TimeTicks deadline_;
  std::unique_ptr<extensions::InstallPromptData> prompt_;
  Client::DoneCallback callback_;
  base::OneShotTimer timer_;
};

struct Registry {
  bool enabled = false;
  std::map<std::string, std::unique_ptr<Pending>> pending;

  void Prune() {
    std::erase_if(pending, [](const auto& entry) { return !entry.second->active(); });
  }
};

Registry& Requests() {
  static base::NoDestructor<Registry> registry;
  return *registry;
}

}  // namespace

namespace remote_browser {

bool IsWindowless(content::WebContents* contents) {
  if (!contents) {
    return false;
  }
  auto browser = CefBrowserHostBase::GetBrowserForContents(contents);
  return browser && browser->IsWindowless();
}

bool HandleInstallPrompt(
    content::WebContents* contents,
    std::unique_ptr<extensions::InstallPromptData>& prompt,
    Client::DoneCallback& callback) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!IsWindowless(contents)) {
    return false;
  }
  auto& requests = Requests();
  requests.Prune();
  const bool supported = requests.enabled && prompt->extension() &&
      prompt->type() == extensions::InstallPromptData::INSTALL_PROMPT &&
      !prompt->requires_parent_permission() &&
      contents->GetPrimaryMainFrame()->GetLastCommittedOrigin().Serialize() ==
          "https://chromewebstore.google.com";
  if (!supported || requests.pending.size() >= kMaximumPending) {
    // Windowless browsers cannot display the fallback Views dialog. An unavailable
    // host or unsupported prompt must refuse rather than attempt that native UI.
    std::move(callback).Run(Client::DoneCallbackPayload(Client::Result::ABORTED));
    return true;
  }
  const int browser_id = CefBrowserHostBase::GetBrowserForContents(contents)->GetIdentifier();
  requests.pending.emplace(
      base::UnguessableToken::Create().ToString(),
      std::make_unique<Pending>(contents, browser_id, std::move(prompt),
                                std::move(callback)));
  return true;
}

}  // namespace remote_browser

int rb_extension_install_enable_v1() {
  if (!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI)) {
    return 0;
  }
  Requests().enabled = true;
  return 1;
}

size_t rb_extension_install_poll_v1(char* data, size_t capacity) {
  if (!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI)) {
    return 0;
  }
  auto& requests = Requests();
  requests.Prune();
  base::ListValue values;
  for (const auto& [id, request] : requests.pending) {
    values.Append(request->Describe(id));
  }
  std::string json;
  if (!base::JSONWriter::Write(values, &json)) {
    return 0;
  }
  if (data && capacity >= json.size()) {
    std::memcpy(data, json.data(), json.size());
  }
  return json.size();
}

int rb_extension_install_resolve_v1(const char* id, int browser_id, int allow) {
  if (!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI)) {
    return 0;
  }
  if (!id || (allow != 0 && allow != 1)) {
    return 0;
  }
  auto& requests = Requests();
  auto found = requests.pending.find(id);
  if (found == requests.pending.end() || found->second->browser_id() != browser_id) {
    return 0;
  }
  return found->second->Resolve(allow == 1) ? 1 : 0;
}

void rb_extension_install_cancel_v1(int browser_id) {
  if (!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI)) {
    return;
  }
  for (auto& [id, request] : Requests().pending) {
    if (browser_id == 0 || browser_id == request->browser_id()) {
      request->Abort();
    }
  }
  Requests().Prune();
}
