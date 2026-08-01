#ifndef CROSSGRAM_TGCALLS_SHIM_PRODUCTION_ADAPTER_TEST_H_
#define CROSSGRAM_TGCALLS_SHIM_PRODUCTION_ADAPTER_TEST_H_

#if !defined(CROSSGRAM_TGCALLS_SHIM_TESTING)
#error "production adapter test seam is test-only"
#endif

#include <memory>
#include <string>

#include <tgcalls/Instance.h>

namespace crossgram::tgcalls_shim {

using ArtifactInstanceCreator = std::unique_ptr<tgcalls::Instance> (*) (
    const std::string& version, tgcalls::Descriptor&& descriptor);

void SetArtifactInstanceCreatorForTest(ArtifactInstanceCreator creator) noexcept;
void ResetArtifactInstanceCreatorForTest() noexcept;

}  // namespace crossgram::tgcalls_shim

#endif  // CROSSGRAM_TGCALLS_SHIM_PRODUCTION_ADAPTER_TEST_H_
