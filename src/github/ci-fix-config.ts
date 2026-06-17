// When false (default), CI auto-fix starts a fresh agent session so it cannot
// clobber or resume an unrelated conversation in the target thread. Set true to
// --resume the fix thread's prior session when one exists.
export const CI_FIX_RESUME_SESSION = false;
