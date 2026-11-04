// Runs before the app hydrates, ahead of the router, which would otherwise
// put the URL fragment back in the address bar (#147).
import { captureSecretFragment } from '@/lib/secretFragment';

captureSecretFragment();
