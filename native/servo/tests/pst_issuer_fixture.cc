// Disposable test issuer. Never linked into the browser or used for public issuers.
#include <openssl/mem.h>
#include <openssl/sha.h>
#include <openssl/trust_token.h>
#include <cassert>
#include <iostream>
#include <set>
#include <string>
#include <vector>

std::string hex(const uint8_t* bytes, size_t len) {
  const char* alphabet = "0123456789abcdef";
  std::string result;
  for (size_t i = 0; i < len; ++i) { result += alphabet[bytes[i] >> 4]; result += alphabet[bytes[i] & 15]; }
  return result;
}
std::vector<uint8_t> unhex(const std::string& input) {
  std::vector<uint8_t> result;
  if (input.size() % 2) return result;
  for (size_t i = 0; i < input.size(); i += 2) {
    const auto digits = input.substr(i, 2);
    if (digits.find_first_not_of("0123456789abcdef") != std::string::npos) return {};
    result.push_back(static_cast<uint8_t>(std::stoul(digits, nullptr, 16)));
  }
  return result;
}
int main() {
  auto* method = TRUST_TOKEN_pst_v1_voprf();
  bssl::UniquePtr<TRUST_TOKEN_ISSUER> issuer(TRUST_TOKEN_ISSUER_new(method, 2));
  uint8_t secret[TRUST_TOKEN_MAX_PRIVATE_KEY_SIZE], public_key[TRUST_TOKEN_MAX_PUBLIC_KEY_SIZE];
  size_t secret_len = 0, public_len = 0;
  assert(TRUST_TOKEN_generate_key(method, secret, &secret_len, sizeof(secret), public_key, &public_len, sizeof(public_key), 7));
  assert(TRUST_TOKEN_ISSUER_add_key(issuer.get(), secret, secret_len));
  OPENSSL_cleanse(secret, sizeof(secret));
  std::cout << hex(public_key, public_len) << std::endl;
  std::set<std::string> spent;
  std::string line;
  while (std::getline(std::cin, line)) {
    const auto split = line.find(' ');
    if (split == std::string::npos) { std::cout << "error" << std::endl; continue; }
    const auto command = line.substr(0, split);
    const auto input = unhex(line.substr(split+1));
    uint8_t* output = nullptr;
    size_t len = 0;
    bool valid = false;
    if (command == "issue") {
      size_t count = 0;
      valid = TRUST_TOKEN_ISSUER_issue(issuer.get(), &output, &len, &count, input.data(), input.size(), 7, 0, 2);
    } else if (command == "redeem") {
      uint32_t public_metadata = 0;
      uint8_t private_metadata = 0;
      TRUST_TOKEN* token = nullptr;
      valid = TRUST_TOKEN_ISSUER_redeem(issuer.get(), &public_metadata, &private_metadata, &token, &output, &len, input.data(), input.size());
      bssl::UniquePtr<TRUST_TOKEN> owned(token);
      if (valid) {
        uint8_t digest[SHA256_DIGEST_LENGTH];
        SHA256(token->data, token->len, digest);
        valid = public_metadata == 7 && spent.insert(hex(digest, sizeof(digest))).second;
      }
    }
    if (valid) std::cout << "ok " << hex(output, len) << std::endl;
    else std::cout << "error" << std::endl;
    OPENSSL_free(output);
  }
}
