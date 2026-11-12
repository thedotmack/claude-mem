import os
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

    def test_active_minutes(self):
        m = 60000
        self.assertEqual(labels.active_minutes([0, 5 * m, 10 * m, 60 * m, 61 * m]), 11)
        self.assertEqual(labels.active_minutes([]), 0)


class Review(unittest.TestCase):
    def setUp(self):
        self._prev_owner = os.environ.get("ACR_OWNER_NAME")
        os.environ["ACR_OWNER_NAME"] = "Alex"       # these cases are a configured owner, not a hardcoded one

    def tearDown(self):
        if self._prev_owner is None: os.environ.pop("ACR_OWNER_NAME", None)
        else: os.environ["ACR_OWNER_NAME"] = self._prev_owner

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

    def test_generated_review_template_inherits_file_level_reviewer(self):
        li = self.items()
        draft = labels.classify(dict(prompts=["build the feature"], text=[]), dict(project="p", user_prompt=None))
        template = labels.review_entry(dict(li[0], session_ids=["session-1"], title="Feature work"), draft)
        self.assertIsNone(template["reviewed_by"])
        template["category"] = "Feature"
        reviewed = dict(reviewed_by="Alex", items=[template])
        self.assertEqual(labels.apply_review(li, reviewed, "t"), 1)
        self.assertEqual((li[0]["reviewed_by"], li[0]["label_source"]), ("Alex", "human"))
        self.assertIsNone(template["reviewed_by"])

    def test_explicit_entry_reviewer_overrides_file_default(self):
        li = self.items()
        reviewed = dict(reviewed_by="Alex", items=[dict(work_item_id="WI-1", category="Feature", reviewed_by="model-x")])
        self.assertEqual(labels.apply_review(li, reviewed, "t"), 1)
        self.assertEqual((li[0]["reviewed_by"], li[0]["label_source"]), ("model-x", "llm"))

    def test_empty_entry_reviewer_and_unconfirmed_category_remain_unreviewed(self):
        li = self.items()
        reviewed = dict(reviewed_by="Alex", items=[
            dict(work_item_id="WI-1", category="Feature", reviewed_by=""),
            dict(work_item_id="WI-2", category=None, reviewed_by=None),
        ])
        self.assertEqual(labels.apply_review(li, reviewed, "t"), 0)
        self.assertEqual([item["label_source"] for item in li], ["keyword", "keyword"])

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

    def test_unset_owner_does_not_treat_alex_as_a_human_review(self):
        os.environ["ACR_OWNER_NAME"] = ""
        li = self.items()
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Feature", reviewed_by="Alex")], "t")
        self.assertEqual(li[0]["label_source"], "llm")
        labels.apply_review(li, [dict(work_item_id="WI-2", category="Feature", reviewed_by="Alex", label_source="human")], "t")
        self.assertEqual(li[1]["label_source"], "human")

    def test_configured_owner_review_is_human_and_other_names_are_not(self):
        os.environ["ACR_OWNER_NAME"] = "Sam"
        li = self.items()
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Feature", reviewed_by="sam"),
                                 dict(work_item_id="WI-2", category="Feature", reviewed_by="Alex")], "t")
        self.assertEqual((li[0]["label_source"], li[1]["label_source"]), ("human", "llm"))

    def test_full_owner_name_also_accepts_its_first_name(self):
        os.environ["ACR_OWNER_NAME"] = "Sam Lee"
        li = self.items()
        labels.apply_review(li, [dict(work_item_id="WI-1", category="Feature", reviewed_by="sam"),
                                 dict(work_item_id="WI-2", category="Feature", reviewed_by="Lee")], "t")
        self.assertEqual((li[0]["label_source"], li[1]["label_source"]), ("human", "llm"))
        signals = labels.classify(dict(prompts=["reset from sam: try again"], text=[]), dict(project="p", user_prompt=None))["failure_signals"]
        self.assertIn("Rework", signals)

    def test_reset_from_owner_is_rework_only_for_the_configured_name(self):
        bare = dict(project="p", user_prompt=None)

        def signals(text):
            return labels.classify(dict(prompts=[text], text=[]), bare)["failure_signals"]

        os.environ["ACR_OWNER_NAME"] = ""
        self.assertNotIn("Rework", signals("reset from alex: try again"))
        self.assertNotIn("Rework", signals("reset from scratch: wipe it"))
        self.assertIn("Rework", signals("redo this"))
        os.environ["ACR_OWNER_NAME"] = "Sam"
        self.assertIn("Rework", signals("reset from Sam: try again"))
        self.assertNotIn("Rework", signals("reset from alex: try again"))
        self.assertNotIn("Rework", signals("reset from scratch: wipe it"))
        os.environ["ACR_OWNER_NAME"] = "Alex"
        self.assertIn("Rework", signals("reset from alex: try again"))

    def test_rejects_unknown_values(self):
        for bad in (dict(category="Rework"), dict(category="Feature", failure_type="Made up"), dict(category="Feature", label_source="magic"), dict(category="Feature", status="done")):
            with self.assertRaises(labels.ReviewError):
                labels.apply_review(self.items(), [dict(work_item_id="WI-1", reviewed_by="Alex", **bad)], "t")


if __name__ == "__main__":
    unittest.main()
