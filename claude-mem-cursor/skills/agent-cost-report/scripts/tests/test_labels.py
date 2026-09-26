import unittest

import _paths  # noqa: F401
from acr import labels


class Classify(unittest.TestCase):
    def ev(self, prompts=(), text=()):
        return dict(prompts=list(prompts), text=list(text))

    def test_category_head_then_tail_then_default(self):
        d = labels.classify(self.ev(["please fix the broken build"]), dict(project="p", user_prompt=None))
        self.assertEqual((d["category"], d["matched"]["category_where"]), ("Bug fix", "head"))
        d = labels.classify(self.ev([], ["benchmark results"]), dict(project="p", user_prompt=None))
        self.assertEqual((d["category"], d["matched"]["category_where"]), ("Experiment", "tail"))
        d = labels.classify(self.ev(), dict(project="p", user_prompt=None))
        self.assertEqual((d["category"], d["matched"]["category_where"]), ("Investigation", "default"))

    def test_failures_closed_set_and_rework_only_as_failure(self):
        d = labels.classify(self.ev(["redo this, verifier found gaps", "x"] + ["same prompt prefix"] * 3), dict(project="p", user_prompt=None))
        self.assertEqual(d["failure_signals"], ["Rework", "Looping"])
        self.assertTrue(all(f in labels.FAILURE_TYPES for f in d["failure_signals"]))
        self.assertNotIn("Rework", labels.CATEGORIES); self.assertNotIn("Rework", [c for c, _ in labels.CAT_RULES])
        self.assertEqual(len(labels.FAILURE_TYPES), 16)

    def test_active_minutes(self):
        m = 60000
        self.assertEqual(labels.active_minutes([0, 5 * m, 10 * m, 60 * m, 61 * m]), 11)
        self.assertEqual(labels.active_minutes([]), 0)


class Review(unittest.TestCase):
    def items(self):
        return [dict(work_item_id="WI-1", category="Investigation", work_category="Investigation", failure_type="", failure_signals=[], label_source="keyword", status="completed"),
                dict(work_item_id="WI-2", category="Investigation", work_category="Investigation", failure_type="", failure_signals=[], label_source="keyword", status="completed")]

    def test_apply_sets_source_and_leaves_unreviewed(self):
        li = self.items()
        n = labels.apply_review(li, [dict(work_item_id="WI-1", category="Feature", failure_signals=["Looping", "Rework"], reviewed_by="alex", status="blocked")], "t")
        self.assertEqual(n, 1); self.assertEqual((li[0]["label_source"], li[0]["failure_type"], li[0]["status"], li[0]["reviewed_at_pt"]), ("human", "Looping", "blocked", "t"))
        self.assertEqual(li[1]["label_source"], "keyword")
        labels.apply_review(li, [dict(work_item_id="WI-2", category="Feature", reviewed_by="model-x")], "t")
        self.assertEqual(li[1]["label_source"], "llm")

    def test_file_level_reviewed_by_default(self):
        li = self.items()
        n = labels.apply_review(li, dict(reviewed_by="Alex", items=[dict(work_item_id="WI-1", category="Feature")]), "t")
        self.assertEqual((n, li[0]["label_source"], li[0]["reviewed_by"]), (1, "human", "Alex"))
        self.assertEqual(labels.apply_review(li, dict(items=[dict(work_item_id="WI-2", category="Feature")]), "t"), 0)

    def test_confirming_a_category_keeps_the_draft_failure_signals(self):
        li = self.items(); li[0]["failure_signals"] = ["Recovery after miss"]; li[0]["failure_type"] = "Recovery after miss"
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Investigation", reviewed_by="Alex", failure_type=None, failure_signals=None)], "t")
        self.assertEqual((li[0]["failure_signals"], li[0]["failure_type"], li[0]["label_source"]), (["Recovery after miss"], "Recovery after miss", "human"))
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Investigation", reviewed_by="Alex", failure_signals=[])], "t")
        self.assertEqual((li[0]["failure_signals"], li[0]["failure_type"]), ([], ""))

    def test_reviewed_title_replaces_the_draft_title(self):
        li = self.items(); li[0]["title"] = li[1]["title"] = "first prompt text"
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Feature", reviewed_by="Alex", title="Rollup shipped"), dict(work_item_id="WI-2", category="Feature", reviewed_by="Alex", title="")], "t")
        self.assertEqual((li[0]["title"], li[1]["title"]), ("Rollup shipped", "first prompt text"))

    def test_rejects_unknown_values(self):
        for bad in (dict(category="Rework"), dict(category="Feature", failure_type="Made up"), dict(category="Feature", label_source="magic"), dict(category="Feature", status="done")):
            with self.assertRaises(labels.ReviewError):
                labels.apply_review(self.items(), [dict(work_item_id="WI-1", reviewed_by="Alex", **bad)], "t")


if __name__ == "__main__":
    unittest.main()
