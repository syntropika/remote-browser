//! Count native human clicks within one tab's position and time window.
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct Clicks {
    last: Option<(Instant, (i32, i32), i32)>,
}

impl Clicks {
    pub(super) fn press(&mut self, position: (i32, i32), now: Instant) {
        let count = self
            .last
            .filter(|(when, previous, _)| {
                now.duration_since(*when) <= Duration::from_millis(500)
                    && position.0.abs_diff(previous.0) <= 4
                    && position.1.abs_diff(previous.1) <= 4
            })
            .map_or(1, |(_, _, count)| count % 3 + 1);
        self.last = Some((now, position, count));
    }

    pub(super) fn count(&self) -> i32 {
        self.last.map_or(1, |(_, _, count)| count)
    }

    pub(super) fn reset(&mut self) {
        self.last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_and_triple_clicks_keep_the_count_for_release() {
        let start = Instant::now();
        let mut clicks = Clicks::default();
        for (ms, expected) in [(0, 1), (100, 2), (200, 3), (300, 1)] {
            clicks.press((100, 120), start + Duration::from_millis(ms));
            assert_eq!(clicks.count(), expected);
        }
    }

    #[test]
    fn timing_and_distance_boundaries_start_a_new_gesture() {
        let start = Instant::now();
        let mut clicks = Clicks::default();
        clicks.press((100, 120), start);
        clicks.press((104, 124), start + Duration::from_millis(500));
        assert_eq!(clicks.count(), 2);
        clicks.press((104, 124), start + Duration::from_millis(1001));
        assert_eq!(clicks.count(), 1);
        clicks.press((109, 124), start + Duration::from_millis(1100));
        assert_eq!(clicks.count(), 1);
        clicks.press((109, 129), start + Duration::from_millis(1200));
        assert_eq!(clicks.count(), 1);
    }

    #[test]
    fn tabs_and_navigation_do_not_share_click_sequences() {
        let start = Instant::now();
        let mut first = Clicks::default();
        let mut second = Clicks::default();
        first.press((10, 20), start);
        first.press((10, 20), start + Duration::from_millis(100));
        second.press((10, 20), start + Duration::from_millis(110));
        assert_eq!(first.count(), 2);
        assert_eq!(second.count(), 1);
        first.reset();
        first.press((10, 20), start + Duration::from_millis(120));
        assert_eq!(first.count(), 1);
    }
}
