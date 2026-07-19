#
# Native AirPlay receiver library for Android (libairplay.so).
#
# Reuses the SAME vendored RPiPlay core the desktop receiver uses (kept in the Electron
# app's tree — single source of truth, no duplication). We drop the desktop main
# (airplayscreen.c) and add jni_bridge.c: it wires the RAOP/FairPlay core's video frames
# up to Kotlin (MediaCodec -> Surface) and decodes+plays the AAC-ELD audio in-process
# (fdk-aac -> miniaudio's AAudio/OpenSL backend). mDNS advertising is the bundled
# bonjour_shim (mdns.h) — no OS Bonjour/Avahi needed, same as the desktop build.
#
cmake_minimum_required(VERSION 3.18)
# CXX is enabled so the shared lib links through the C++ driver — fdk-aac is C++ and
# pulls in libc++ (see LINKER_LANGUAGE below); every source here is still plain C.
project(airplay C CXX)

set(CMAKE_C_STANDARD 11)

# The vendored core lives in the Electron app's native tree (5 levels up from here).
set(CORE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../androidlab-electron/native/macos/airplay")
get_filename_component(CORE "${CORE}" ABSOLUTE)
if(NOT EXISTS "${CORE}/raop.c")
  message(FATAL_ERROR "RPiPlay core not found at ${CORE} — is the repo layout intact?")
endif()

# Cross-compiled deps from deps/build-android-deps.sh, per ABI.
set(PREBUILT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../deps/prebuilt/${ANDROID_ABI}")
get_filename_component(PREBUILT "${PREBUILT}" ABSOLUTE)
if(NOT EXISTS "${PREBUILT}/lib/libcrypto.a")
  message(FATAL_ERROR
    "Native deps for ${ANDROID_ABI} missing at ${PREBUILT}.\n"
    "Run:  ABIS=\"${ANDROID_ABI}\" deps/build-android-deps.sh  first.")
endif()

# Core sources (+ playfair + llhttp), minus the desktop main. bonjour_shim.c and
# miniaudio_impl.c live in the core dir and ARE wanted (advertiser + audio backend).
file(GLOB CORE_SRC "${CORE}/*.c" "${CORE}/playfair/*.c" "${CORE}/llhttp/*.c")
list(FILTER CORE_SRC EXCLUDE REGEX "/airplayscreen\\.c$")

add_library(airplay SHARED
  ${CORE_SRC}
  "${CMAKE_CURRENT_SOURCE_DIR}/jni_bridge.c")

target_include_directories(airplay PRIVATE
  "${CORE}"
  "${CORE}/llhttp"
  "${CORE}/playfair"
  "${CORE}/vendor"        # miniaudio.h, mdns.h (header-only)
  "${PREBUILT}/include")

# dnssd.c -> bonjour_shim instead of the OS dns_sd; SOL_TCP is a glibc-ism bionic lacks.
# MA_NO_AAUDIO: force miniaudio's OpenSL ES backend — AAudio's setUsage/setContentType/
# setInputPreset are __INTRODUCED_IN(28) and would hard-error at minSdk 26. OpenSL ES is
# available since API 21 and is plenty for playback.
target_compile_definitions(airplay PRIVATE
  USE_BUNDLED_MDNS
  SOL_TCP=IPPROTO_TCP
  MA_NO_AAUDIO)

# Third-party core — silence its warnings, optimise.
target_compile_options(airplay PRIVATE -w -O2 -fvisibility=hidden)

# --- prebuilt static deps ---------------------------------------------------
add_library(crypto  STATIC IMPORTED)
set_target_properties(crypto  PROPERTIES IMPORTED_LOCATION "${PREBUILT}/lib/libcrypto.a")
add_library(plist   STATIC IMPORTED)
set_target_properties(plist   PROPERTIES IMPORTED_LOCATION "${PREBUILT}/lib/libplist-2.0.a")
add_library(fdkaac  STATIC IMPORTED)
set_target_properties(fdkaac  PROPERTIES IMPORTED_LOCATION "${PREBUILT}/lib/libfdk-aac.a")

find_library(log-lib log)
find_library(android-lib android)
find_library(opensl-lib OpenSLES)   # miniaudio's OpenSL ES fallback backend

target_link_libraries(airplay
  crypto plist fdkaac
  ${log-lib} ${android-lib} ${opensl-lib} m)

# fdk-aac is C++ — link with the C++ driver so libc++ (ANDROID_STL=c++_static) is pulled
# in and its symbols resolve, even though all of OUR sources are C.
set_target_properties(airplay PROPERTIES LINKER_LANGUAGE CXX)

# 16 KB page-size ELF alignment: Android 15 warns and Android 16 requires shared libs to
# load on 16 KB-page devices. NDK 27+ defaults to this; set it explicitly for NDK 26.
target_link_options(airplay PRIVATE "-Wl,-z,max-page-size=16384")
