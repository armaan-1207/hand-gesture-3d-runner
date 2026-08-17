/**
 * Custom fingerpose gesture definitions for Cyber Runner.
 */
import {
  GestureDescription,
  GestureEstimator,
  Finger,
  FingerCurl,
} from 'fingerpose';

// FIST: all four fingers fully curled (thumb ignored - unreliable in side view)
const FistGesture = new GestureDescription('FIST');
FistGesture.addCurl(Finger.Index,  FingerCurl.FullCurl, 1.0);
FistGesture.addCurl(Finger.Middle, FingerCurl.FullCurl, 1.0);
FistGesture.addCurl(Finger.Ring,   FingerCurl.FullCurl, 1.0);
FistGesture.addCurl(Finger.Pinky,  FingerCurl.FullCurl, 1.0);
// HalfCurl fallback so partial grips still count
FistGesture.addCurl(Finger.Index,  FingerCurl.HalfCurl, 0.7);
FistGesture.addCurl(Finger.Middle, FingerCurl.HalfCurl, 0.7);
FistGesture.addCurl(Finger.Ring,   FingerCurl.HalfCurl, 0.7);
FistGesture.addCurl(Finger.Pinky,  FingerCurl.HalfCurl, 0.7);

// OPEN PALM: all fingers fully extended
const OpenPalmGesture = new GestureDescription('OPEN');
OpenPalmGesture.addCurl(Finger.Index,  FingerCurl.NoCurl, 1.0);
OpenPalmGesture.addCurl(Finger.Middle, FingerCurl.NoCurl, 1.0);
OpenPalmGesture.addCurl(Finger.Ring,   FingerCurl.NoCurl, 1.0);
OpenPalmGesture.addCurl(Finger.Pinky,  FingerCurl.NoCurl, 1.0);

// Single shared estimator (avoid re-creating every frame)
export const gestureEstimator = new GestureEstimator([
  FistGesture,
  OpenPalmGesture,
]);
