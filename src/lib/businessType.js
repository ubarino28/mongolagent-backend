"use strict";

const LABELS = {
  clinic: {
    staff:           "эмч",
    staffCap:        "Эмч",
    staffPlural:     "эмч нарын",
    staffWith:       "эмчтэй",
    staffPluralUI:   "Эмч нар",
    add:             "Эмч нэмэх",
    edit:            "Эмч засах",
    namePlaceholder: "Эмчийн нэр",
    empty:           "Эмч байхгүй",
    select:          "Эмч сонгоно уу",
    selectHint:      "Зүүн талаас эмч дарж цагийн хуваарийг харна уу",
    telegramKey:     "Эмч",
    appointment:     "Үзлэгийн цаг",
  },
  restaurant: {
    staff:           "тогооч",
    staffCap:        "Тогооч",
    staffPlural:     "тогоочдын",
    staffWith:       "тогоочтой",
    staffPluralUI:   "Тогоочид",
    add:             "Тогооч нэмэх",
    edit:            "Тогооч засах",
    namePlaceholder: "Тогоочийн нэр",
    empty:           "Тогооч байхгүй",
    select:          "Тогооч сонгоно уу",
    selectHint:      "Зүүн талаас тогооч дарж цагийн хуваарийг харна уу",
    telegramKey:     "Тогооч",
    appointment:     "Ширээ захиалга",
  },
  service: {
    staff:           "ажилтан",
    staffCap:        "Ажилтан",
    staffPlural:     "ажилтнуудын",
    staffWith:       "ажилтантай",
    staffPluralUI:   "Ажилтнууд",
    add:             "Ажилтан нэмэх",
    edit:            "Ажилтан засах",
    namePlaceholder: "Ажилтны нэр",
    empty:           "Ажилтан байхгүй",
    select:          "Ажилтан сонгоно уу",
    selectHint:      "Зүүн талаас ажилтан дарж цагийн хуваарийг харна уу",
    telegramKey:     "Ажилтан",
    appointment:     "Цаг захиалга",
  },
};

const DEFAULT = {
  staff:           "мастер",
  staffCap:        "Мастер",
  staffPlural:     "мастеруудын",
  staffWith:       "мастертай",
  staffPluralUI:   "Мастерууд",
  add:             "Мастер нэмэх",
  edit:            "Мастер засах",
  namePlaceholder: "Мастерын нэр",
  empty:           "Мастер байхгүй",
  select:          "Мастер сонгоно уу",
  selectHint:      "Зүүн талаас мастер дарж цагийн хуваарийг харна уу",
  telegramKey:     "Мастер",
  appointment:     "Цагийн захиалга",
};

function getLabels(businessType) {
  return LABELS[businessType] || DEFAULT;
}

function getStaffLabel(businessType) {
  return getLabels(businessType).staffCap;
}

function getAppointmentLabel(businessType) {
  return getLabels(businessType).appointment;
}

module.exports = { getLabels, getStaffLabel, getAppointmentLabel };
