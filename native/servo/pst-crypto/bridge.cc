// Safe Rust-facing ownership boundary for pinned BoringSSL PST V1 VOPRF.
#include <openssl/mem.h>
#include <openssl/trust_token.h>
#include <cstdint>
#include <cstring>
#include <vector>

extern "C" {
void* servo_pst_new(size_t batch) {
  return TRUST_TOKEN_CLIENT_new(TRUST_TOKEN_pst_v1_voprf(), batch);
}
void servo_pst_drop(void* client) {
  TRUST_TOKEN_CLIENT_free(static_cast<TRUST_TOKEN_CLIENT*>(client));
}
void servo_pst_free(uint8_t* data) { OPENSSL_free(data); }
int servo_pst_add_key(void* client, const uint8_t* key, size_t len, size_t* index) {
  return TRUST_TOKEN_CLIENT_add_key(static_cast<TRUST_TOKEN_CLIENT*>(client), index, key, len);
}
int servo_pst_begin(void* client, size_t count, uint8_t** out, size_t* len) {
  return TRUST_TOKEN_CLIENT_begin_issuance(static_cast<TRUST_TOKEN_CLIENT*>(client), out, len, count);
}
int servo_pst_finish(void* client, const uint8_t* response, size_t response_len,
                     uint8_t** out, size_t* len, size_t* key_index) {
  STACK_OF(TRUST_TOKEN)* tokens = TRUST_TOKEN_CLIENT_finish_issuance(
      static_cast<TRUST_TOKEN_CLIENT*>(client), key_index, response, response_len);
  if (!tokens) return 0;
  std::vector<uint8_t> encoded;
  for (size_t i = 0; i < sk_TRUST_TOKEN_num(tokens); ++i) {
    auto* token = sk_TRUST_TOKEN_value(tokens, i);
    // Length-prefixed tokens are copied, never exposed as native pointers.
    if (token->len > 65535) { sk_TRUST_TOKEN_pop_free(tokens, TRUST_TOKEN_free); return 0; }
    encoded.push_back(static_cast<uint8_t>(token->len >> 8));
    encoded.push_back(static_cast<uint8_t>(token->len));
    encoded.insert(encoded.end(), token->data, token->data + token->len);
  }
  sk_TRUST_TOKEN_pop_free(tokens, TRUST_TOKEN_free);
  if (encoded.empty()) return 0;
  *out = static_cast<uint8_t*>(OPENSSL_memdup(encoded.data(), encoded.size()));
  *len = encoded.size();
  return *out != nullptr;
}
int servo_pst_redeem(const uint8_t* token, size_t token_len,
                     const uint8_t* data, size_t data_len, uint8_t** out, size_t* len) {
  bssl::UniquePtr<TRUST_TOKEN_CLIENT> client(TRUST_TOKEN_CLIENT_new(TRUST_TOKEN_pst_v1_voprf(), 1));
  bssl::UniquePtr<TRUST_TOKEN> owned(TRUST_TOKEN_new(token, token_len));
  if (!client || !owned) return 0;
  return TRUST_TOKEN_CLIENT_begin_redemption(client.get(), out, len, owned.get(), data, data_len, 0);
}
}
