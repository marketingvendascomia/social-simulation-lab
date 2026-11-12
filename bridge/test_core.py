import unittest
from bridge.core import active_ids, events_for, chunks


class SimulationPolicyTests(unittest.TestCase):
    def test_seed_repeats_selection_and_inactive_hours_are_respected(self):
        config = {"seed": 42, "minutesPerRound": 60}
        personas = [{"id": 0, "activeHours": [0], "activityProbability": 1},
                    {"id": 1, "activeHours": [4], "activityProbability": 1}]
        self.assertEqual(active_ids(personas, config, 0), [0])
        self.assertEqual(active_ids(personas, config, 1), [])
        self.assertEqual(active_ids(personas, config, 0), active_ids(personas, config, 0))

    def test_events_only_execute_at_their_round(self):
        config = {"events": [{"round": 2, "content": "event", "agentId": 0}]}
        self.assertEqual(events_for(config, 1), [])
        self.assertEqual(len(events_for(config, 2)), 1)

    def test_chunks_preserve_all_source_text(self):
        text = "Informação original. " * 500
        self.assertEqual("".join(chunks(text)), text)


if __name__ == "__main__":
    unittest.main()
