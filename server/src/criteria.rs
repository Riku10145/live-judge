use serde::{Serialize, Serializer};

pub struct Criterion {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub hue: u16,
    pub prompt: Prompt,
}

pub struct Level {
    pub label: &'static str,
    pub criteria: &'static str,
}

#[derive(Serialize)]
pub struct Opt {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(skip)]
    pub criteria: &'static str,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Prompt {
    Boolean {
        #[serde(skip)]
        instructions: &'static str,
        true_label: &'static str,
        false_label: &'static str,
        #[serde(skip)]
        true_criteria: &'static str,
        #[serde(skip)]
        false_criteria: &'static str,
    },
    Score {
        #[serde(skip)]
        instructions: &'static str,
        #[serde(serialize_with = "level_labels")]
        levels: &'static [Level],
    },
    Choice {
        #[serde(skip)]
        instructions: &'static str,
        options: &'static [Opt],
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CriterionWire<'a> {
    id: &'a str,
    label: &'a str,
    blurb: &'a str,
    hue: u16,
    prompt: &'a Prompt,
}

impl Serialize for Criterion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        CriterionWire {
            id: self.id,
            label: self.label,
            blurb: self.blurb,
            hue: self.hue,
            prompt: &self.prompt,
        }
        .serialize(serializer)
    }
}

fn level_labels<S: Serializer>(
    levels: &&'static [Level],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(levels.iter().map(|level| level.label))
}

#[cfg(test)]
impl Criterion {
    fn outcome_count(&self) -> usize {
        match &self.prompt {
            Prompt::Boolean { .. } => 2,
            Prompt::Score { levels, .. } => levels.len(),
            Prompt::Choice { options, .. } => options.len(),
        }
    }
}

pub fn find(id: &str) -> Option<&'static Criterion> {
    CRITERIA.iter().find(|criterion| criterion.id == id)
}

pub static CRITERIA: &[Criterion] = &[
    Criterion {
        id: "positivity",
        label: "前向きさ",
        blurb: "この一言は前を向いているか",
        hue: 152,
        prompt: Prompt::Boolean {
            instructions: "この文は前向きな気持ちで書かれているか。",
            true_label: "前向き",
            false_label: "後ろ向き",
            true_criteria: "満足、期待、感謝、喜びなど、状況を肯定的に受け止めている",
            false_criteria: "不満、落胆、諦め、怒りなど、状況を否定的に受け止めている",
        },
    },
    Criterion {
        id: "intensity",
        label: "強度",
        blurb: "どれくらい振り切れているか",
        hue: 28,
        prompt: Prompt::Score {
            instructions: "この文の感情の振れ幅はどれくらいか。",
            levels: &[
                Level {
                    label: "ぼそっと",
                    criteria: "淡々としていて、感情がほとんど表に出ていない",
                },
                Level {
                    label: "ふつう",
                    criteria: "感情は伝わるが、抑制が効いている",
                },
                Level {
                    label: "強め",
                    criteria: "はっきりと感情が出ていて、語気が強い",
                },
                Level {
                    label: "振り切れ",
                    criteria: "感情を抑えきれず、誇張や叫びに近い書き方になっている",
                },
            ],
        },
    },
    Criterion {
        id: "register",
        label: "ネタ / 本気",
        blurb: "笑わせにきたのか、本気なのか",
        hue: 276,
        prompt: Prompt::Choice {
            instructions: "この文は笑わせにいっているか、それとも本気で書かれているか。",
            options: &[
                Opt {
                    key: "neta",
                    label: "ネタ",
                    criteria: "冗談、誇張、内輪ノリなど、笑わせることを狙っている",
                },
                Opt {
                    key: "honki",
                    label: "本気",
                    criteria: "真面目な評価や心情の表明として書かれている",
                },
            ],
        },
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_criterion_is_addressable_and_well_formed() {
        assert!(!CRITERIA.is_empty());
        for criterion in CRITERIA {
            assert!(criterion.hue < 360, "{} hue out of range", criterion.id);
            assert!(
                criterion.outcome_count() >= 2,
                "{} needs outcomes",
                criterion.id
            );
            assert!(find(criterion.id).is_some());
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = CRITERIA.iter().map(|c| c.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn score_rubrics_stay_inside_the_provider_limit() {
        for criterion in CRITERIA {
            if let Prompt::Score { levels, .. } = &criterion.prompt {
                assert!(
                    (2..=10).contains(&levels.len()),
                    "{} rubric size",
                    criterion.id
                );
            }
        }
    }

    #[test]
    fn wire_shape_hides_the_model_facing_text() {
        let json = serde_json::to_value(&CRITERIA[0]).unwrap();
        assert_eq!(json["id"], "positivity");
        assert_eq!(json["prompt"]["type"], "boolean");
        assert_eq!(json["prompt"]["trueLabel"], "前向き");
        assert!(json["prompt"]["instructions"].is_null());
        assert!(json["visual"].is_null());

        let score = serde_json::to_value(&CRITERIA[1]).unwrap();
        assert_eq!(
            score["prompt"]["levels"],
            serde_json::json!(["ぼそっと", "ふつう", "強め", "振り切れ"])
        );

        let choice = serde_json::to_value(&CRITERIA[2]).unwrap();
        assert_eq!(choice["prompt"]["options"][0]["key"], "neta");
        assert!(choice["prompt"]["options"][0]["criteria"].is_null());
    }
}
