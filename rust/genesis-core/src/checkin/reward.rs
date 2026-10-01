//! Check-in streak milestone reward gates — Node `reward.ts` pure helpers.

/// Node `CHECKIN_REWARD_EVERY_DAYS` — trophy / streak prize cycle length.
pub const CHECKIN_REWARD_EVERY_DAYS: i32 = 7;

const _: () = assert!(CHECKIN_REWARD_EVERY_DAYS == 7);

/// Node `shouldGrantStreakMilestoneReward` — true on 7, 14, 21, …
pub fn should_grant_streak_milestone_reward(next_streak: i32) -> bool {
    let n = next_streak.max(0);
    n > 0 && n % CHECKIN_REWARD_EVERY_DAYS == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn milestone_only_on_multiples() {
        assert!(should_grant_streak_milestone_reward(CHECKIN_REWARD_EVERY_DAYS));
        assert!(should_grant_streak_milestone_reward(2 * CHECKIN_REWARD_EVERY_DAYS));
        assert!(!should_grant_streak_milestone_reward(1));
        assert!(!should_grant_streak_milestone_reward(0));
        assert!(!should_grant_streak_milestone_reward(-7));
    }
}
