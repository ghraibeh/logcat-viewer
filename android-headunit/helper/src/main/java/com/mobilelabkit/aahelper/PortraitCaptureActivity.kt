package com.mobilelabkit.aahelper

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * A portrait-locked QR scanner. zxing-android-embedded's stock [CaptureActivity] opens in
 * landscape; this subclass exists only so the manifest can pin it to `screenOrientation="portrait"`
 * (a phone held upright), which is what people expect when scanning the head unit's on-screen QR.
 */
class PortraitCaptureActivity : CaptureActivity()
