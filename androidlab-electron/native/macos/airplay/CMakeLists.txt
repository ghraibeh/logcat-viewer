#
# Cross-platform build for the AirPlay screen-mirror receiver `airplayscreen`
# (macOS / Windows / Linux). One executable links the vendored RPiPlay core
# (GPL-3.0), the bundled mDNS advertiser (bonjour_shim + vendor/mdns.h), and the
# portable main (airplayscreen.c: fdk-aac decode + miniaudio playback).
#
# Deps resolved per platform (pass *_ROOT hints from the Node build script):
#   - OpenSSL libcrypto  (FairPlay AES/RSA)     — OPENSSL_ROOT_DIR
#   - libplist-2.0       (AirPlay plist bodies) — PLIST_ROOT
#   - fdk-aac            (AAC-ELD decode)       — FDKAAC_ROOT
# mDNS/Bonjour is NOT a dependency — the bundled advertiser replaces it everywhere.
#
cmake_minimum_required(VERSION 3.15)
project(airplayscreen C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Every .c under this dir (core + bonjour_shim + miniaudio_impl + main) plus the
# playfair/llhttp subtrees. mdns.h and miniaudio.h in vendor/ are header-only.
file(GLOB_RECURSE AP_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.c")
# Never sweep up an in-source CMake build tree (its generated CMakeCCompilerId.c has
# its own main() and would break the link). Out-of-source builds avoid this too.
list(FILTER AP_SOURCES EXCLUDE REGEX "/(build|_build|cmake-build)[^/]*/")

add_executable(airplayscreen ${AP_SOURCES})

target_include_directories(airplayscreen PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/llhttp"
  "${CMAKE_CURRENT_SOURCE_DIR}/playfair"
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor")

# The bundled advertiser replaces the OS dns_sd (see dnssd.c / bonjour_shim.c).
target_compile_definitions(airplayscreen PRIVATE USE_BUNDLED_MDNS)

# The vendored core is third-party — silence its warnings.
if(MSVC)
  target_compile_options(airplayscreen PRIVATE /w)
  target_compile_definitions(airplayscreen PRIVATE _CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN)
else()
  target_compile_options(airplayscreen PRIVATE -w -O2)
endif()

# --- dependencies -----------------------------------------------------------
find_package(OpenSSL REQUIRED)          # honours OPENSSL_ROOT_DIR
target_link_libraries(airplayscreen OpenSSL::Crypto)

find_path(PLIST_INCLUDE NAMES plist/plist.h HINTS "${PLIST_ROOT}/include")
find_library(PLIST_LIB NAMES plist-2.0 plist libplist-2.0 HINTS "${PLIST_ROOT}/lib")
if(NOT PLIST_LIB)
  message(FATAL_ERROR "libplist not found (set PLIST_ROOT). brew/apt/vcpkg install libplist.")
endif()
target_include_directories(airplayscreen PRIVATE "${PLIST_INCLUDE}")
target_link_libraries(airplayscreen "${PLIST_LIB}")

find_path(FDKAAC_INCLUDE NAMES fdk-aac/aacdecoder_lib.h HINTS "${FDKAAC_ROOT}/include")
find_library(FDKAAC_LIB NAMES fdk-aac HINTS "${FDKAAC_ROOT}/lib")
if(NOT FDKAAC_LIB)
  message(FATAL_ERROR "fdk-aac not found (set FDKAAC_ROOT). brew/apt/vcpkg install fdk-aac.")
endif()
target_include_directories(airplayscreen PRIVATE "${FDKAAC_INCLUDE}")
target_link_libraries(airplayscreen "${FDKAAC_LIB}")

# --- platform system libraries ---------------------------------------------
if(APPLE)
  # The vendored core uses Linux socket constant names; map them on macOS.
  target_compile_definitions(airplayscreen PRIVATE SOL_TCP=IPPROTO_TCP TCP_KEEPIDLE=TCP_KEEPALIVE)
  target_link_libraries(airplayscreen
    "-framework CoreFoundation" "-framework CoreAudio"
    "-framework AudioToolbox" "-framework AudioUnit")
elseif(WIN32)
  target_link_libraries(airplayscreen ws2_32 iphlpapi ole32)
else() # Linux / other Unix
  find_package(Threads REQUIRED)
  target_link_libraries(airplayscreen Threads::Threads ${CMAKE_DL_LIBS} m)
endif()

# Emit the binary straight into resources/ (electron-builder bundles it).
set_target_properties(airplayscreen PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../../resources")
