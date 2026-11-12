"""Pure policies shared by the OASIS adapter and dependency-free unit tests."""
import random


def active_ids(personas, config, round_number):
    hour = (round_number * config["minutesPerRound"] // 60) % 24
    generator = random.Random(config["seed"] + round_number)
    return [p["id"] for p in personas if hour in p["activeHours"]
            and generator.random() < p["activityProbability"]]


def events_for(config, round_number):
    return [(index, event) for index, event in enumerate(config["events"])
            if event["round"] == round_number]


def chunks(text, size=3000):
    return [text[i:i + size] for i in range(0, len(text), size)]
