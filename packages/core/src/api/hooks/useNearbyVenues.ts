import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

export type NearbyVenue = components['schemas']['NearbyVenue'];

/**
 * Food and drink places near `at` (#62), for "Where are you?" (#61). The
 * position goes only in this request; it's rounded to 3 places (~110 m) so
 * small moves reuse the answer.
 */
export function useNearbyVenues(at: { lat: number; lng: number } | null) {
  const lat = at ? Math.round(at.lat * 1000) / 1000 : null;
  const lng = at ? Math.round(at.lng * 1000) / 1000 : null;
  return useQuery<NearbyVenue[], ApiError>({
    queryKey: ['nearby-venues', lat, lng],
    queryFn: async () =>
      (await api<{ venues: NearbyVenue[] }>(`/v1/venues/nearby?lat=${lat}&lng=${lng}`)).venues,
    enabled: lat !== null && lng !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
