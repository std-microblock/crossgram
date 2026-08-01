#include <array>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <memory>

#include <rtc_base/thread.h>
#include <tgcalls/ThreadLocalObject.h>

namespace {

constexpr uint8_t kKeyByte = 0xa5;

[[noreturn]] void Fail() {
  std::abort();
}

void Check(bool condition) {
  if (!condition) Fail();
}

class KeyReader final {
 public:
  KeyReader(std::shared_ptr<std::array<uint8_t, 256>> key, std::atomic<uint32_t>* destroyed)
      : key_(std::move(key)), destroyed_(destroyed) {}

  ~KeyReader() {
    Check(key_->front() == kKeyByte);
    destroyed_->fetch_add(1, std::memory_order_release);
  }

 private:
  const std::shared_ptr<std::array<uint8_t, 256>> key_;
  std::atomic<uint32_t>* const destroyed_;
};

void Wipe(const std::shared_ptr<std::array<uint8_t, 256>>& key) {
  key->fill(0);
}

void TestExternalThreadBarrier() {
  auto thread = rtc::Thread::Create();
  thread->Start();
  auto key = std::make_shared<std::array<uint8_t, 256>>();
  key->fill(kKeyByte);
  std::atomic<uint32_t> destroyed{0};
  tgcalls::ThreadLocalObject<KeyReader> owner(thread.get(), [&] {
    return std::make_shared<KeyReader>(key, &destroyed);
  });

  owner.resetSync();
  Check(destroyed.load(std::memory_order_acquire) == 1);
  Wipe(key);
}

void TestOwningThreadBarrierDoesNotDeadlock() {
  auto thread = rtc::Thread::Create();
  thread->Start();
  auto key = std::make_shared<std::array<uint8_t, 256>>();
  key->fill(kKeyByte);
  std::atomic<uint32_t> destroyed{0};
  tgcalls::ThreadLocalObject<KeyReader> owner(thread.get(), [&] {
    return std::make_shared<KeyReader>(key, &destroyed);
  });

  thread->BlockingCall([&] { owner.resetSync(); });
  Check(destroyed.load(std::memory_order_acquire) == 1);
  Wipe(key);
}

}  // namespace

int main() {
  TestExternalThreadBarrier();
  TestOwningThreadBarrierDoesNotDeadlock();
  return 0;
}
