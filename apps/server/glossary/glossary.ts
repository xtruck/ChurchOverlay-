/**
 * ARCHITECTURE.md section 65.5: a small, fixed, bundled glossary — dozens
 * of common theological terms, not hundreds, and explicitly NOT a Greek/
 * Hebrew lexicon (a real, separate data-licensing undertaking flagged out
 * of scope for this note). Bilingual, matching the app's own primary
 * deployment target (a French-speaking church, per section 65.11) —
 * each entry is its own English or French trigger phrase, not a generic
 * cross-language term index, since "grace"/"grâce" collide once accents
 * are stripped and there is no reliable way to infer which language a
 * bare term was spoken in without the surrounding trigger phrase.
 */
export type GlossaryEntry = {
  /** Already accent-stripped, lowercased trigger phrases (see GlossaryDetector). */
  readonly phrases: readonly string[]
  readonly term: string
  readonly definition: string
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    phrases: ["define grace", "what does grace mean"],
    term: "Grace",
    definition: "Unmerited favor from God — a gift given freely, not earned by good works.",
  },
  {
    phrases: ["definis la grace", "definis grace", "que veut dire la grace", "que veut dire grace"],
    term: "Grâce",
    definition: "Une faveur imméritée de Dieu — un don accordé librement, non gagné par de bonnes œuvres.",
  },
  {
    phrases: ["define sin", "what does sin mean"],
    term: "Sin",
    definition: "Any thought, word, or act that falls short of God's standard — a transgression against His will.",
  },
  {
    phrases: ["definis le peche", "definis peche", "que veut dire le peche", "que veut dire peche"],
    term: "Péché",
    definition: "Toute pensée, parole ou action qui ne répond pas à la norme de Dieu — une transgression envers Sa volonté.",
  },
  {
    phrases: ["define salvation", "what does salvation mean"],
    term: "Salvation",
    definition: "Deliverance from sin and its consequences, granted through faith in Jesus Christ.",
  },
  {
    phrases: ["definis le salut", "que veut dire le salut"],
    term: "Salut",
    definition: "La délivrance du péché et de ses conséquences, accordée par la foi en Jésus-Christ.",
  },
  {
    phrases: ["define redemption", "what does redemption mean"],
    term: "Redemption",
    definition: "Being bought back from bondage to sin, at the cost of Christ's sacrifice.",
  },
  {
    phrases: ["definis la redemption", "que veut dire la redemption"],
    term: "Rédemption",
    definition: "Le rachat de l'esclavage du péché, au prix du sacrifice du Christ.",
  },
  {
    phrases: ["define faith", "what does faith mean"],
    term: "Faith",
    definition: "Trust and confidence in God and His promises, even without visible proof.",
  },
  {
    phrases: ["definis la foi", "que veut dire la foi"],
    term: "Foi",
    definition: "La confiance en Dieu et en Ses promesses, même sans preuve visible.",
  },
  {
    phrases: ["define repentance", "what does repentance mean"],
    term: "Repentance",
    definition: "A genuine change of heart and mind, turning away from sin and toward God.",
  },
  {
    phrases: ["definis la repentance", "que veut dire la repentance"],
    term: "Repentance",
    definition: "Un véritable changement de cœur et d'esprit, se détournant du péché pour se tourner vers Dieu.",
  },
  {
    phrases: ["define covenant", "what does covenant mean"],
    term: "Covenant",
    definition: "A binding agreement or promise between God and His people.",
  },
  {
    phrases: ["definis l'alliance", "que veut dire l'alliance"],
    term: "Alliance",
    definition: "Un accord ou une promesse durable entre Dieu et Son peuple.",
  },
  {
    phrases: ["define righteousness", "what does righteousness mean"],
    term: "Righteousness",
    definition: "Moral uprightness and conformity to God's standard of what is right.",
  },
  {
    phrases: ["definis la justice", "que veut dire la justice"],
    term: "Justice",
    definition: "La droiture morale et la conformité à la norme de Dieu quant à ce qui est juste.",
  },
  {
    phrases: ["define gospel", "what does gospel mean"],
    term: "Gospel",
    definition: "The \"good news\" of salvation through Jesus Christ's death and resurrection.",
  },
  {
    phrases: ["definis l'evangile", "que veut dire l'evangile"],
    term: "Évangile",
    definition: "La « bonne nouvelle » du salut par la mort et la résurrection de Jésus-Christ.",
  },
  {
    phrases: ["define sanctification", "what does sanctification mean"],
    term: "Sanctification",
    definition: "The ongoing process of being made holy, set apart for God's purposes.",
  },
  {
    phrases: ["definis la sanctification", "que veut dire la sanctification"],
    term: "Sanctification",
    definition: "Le processus continu de purification, mis à part pour les desseins de Dieu.",
  },
  {
    phrases: ["define atonement", "what does atonement mean"],
    term: "Atonement",
    definition: "The reconciliation between God and humanity, made possible through Christ's sacrifice.",
  },
  {
    phrases: ["definis l'expiation", "que veut dire l'expiation"],
    term: "Expiation",
    definition: "La réconciliation entre Dieu et l'humanité, rendue possible par le sacrifice du Christ.",
  },
  {
    phrases: ["define trinity", "what does trinity mean"],
    term: "Trinity",
    definition: "The Christian doctrine that God is one being who exists eternally as Father, Son, and Holy Spirit.",
  },
  {
    phrases: ["definis la trinite", "que veut dire la trinite"],
    term: "Trinité",
    definition: "La doctrine chrétienne selon laquelle Dieu est un seul être existant éternellement comme Père, Fils et Saint-Esprit.",
  },
]
