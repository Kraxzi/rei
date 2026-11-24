/** Input forms for the financial models of @rei/core (the formulas themselves live only in core). */

export type InputKind = 'money' | 'percent' | 'int' | 'number';

export interface ModelField {
  key: string;
  label: string;
  kind: InputKind;
  hint?: string;
  required?: boolean;
}

export interface ModelForm {
  code: string;
  label: string;
  explain: string;
  fields: ModelField[];
}

export const MODEL_FORMS: Record<string, ModelForm> = {
  residential_long_term: {
    code: 'residential_long_term',
    label: 'Долгосрочная аренда',
    explain: 'Арендатор на год и больше, фиксированная плата в месяц.',
    fields: [{ key: 'monthlyRent', label: 'Аренда в месяц', kind: 'money', required: true }],
  },
  residential_short_term: {
    code: 'residential_short_term',
    label: 'Посуточная аренда',
    explain: 'Сдача туристам через платформы. Простой учитывается через загрузку.',
    fields: [
      { key: 'adr', label: 'Средняя цена за ночь', kind: 'money', required: true },
      { key: 'occupancy', label: 'Загрузка', kind: 'percent', hint: 'доля проданных ночей в году', required: true },
      { key: 'avgStayNights', label: 'Средний срок проживания, ночей', kind: 'number', required: true },
      { key: 'cleaningPerStay', label: 'Уборка за заезд', kind: 'money', required: true },
      { key: 'platformFeeRate', label: 'Комиссия платформы', kind: 'percent', required: true },
    ],
  },
  unit_rental: {
    code: 'unit_rental',
    label: 'Аренда мест или боксов',
    explain: 'Гаражи, парковочные места, боксы, причалы: количество × ставка × загрузка.',
    fields: [
      { key: 'units', label: 'Количество мест', kind: 'int', required: true },
      { key: 'monthlyRatePerUnit', label: 'Аренда одного места в месяц', kind: 'money', required: true },
      { key: 'occupancy', label: 'Загрузка', kind: 'percent', hint: '100 % — все места всегда сданы', required: true },
    ],
  },
  commercial_lease: {
    code: 'commercial_lease',
    label: 'Сдано арендаторам по договорам',
    explain: 'Доход по действующим договорам. Срок до окончания договоров даёт WAULT.',
    fields: [],
  },
  hospitality: {
    code: 'hospitality',
    label: 'Гостиничный бизнес',
    explain: 'Отель, B&B, кемпинг: номера × цена × загрузка минус персонал и комиссии.',
    fields: [
      { key: 'rooms', label: 'Номеров или мест', kind: 'int', required: true },
      { key: 'adr', label: 'Средняя цена за ночь', kind: 'money', required: true },
      { key: 'occupancy', label: 'Загрузка за год', kind: 'percent', required: true },
      { key: 'otherRevenueRate', label: 'Доп. доход (завтраки, бар)', kind: 'percent', hint: 'от дохода с номеров' },
      { key: 'platformCommissionRate', label: 'Комиссия платформ', kind: 'percent', required: true },
      { key: 'cleaningPerOccupiedRoom', label: 'Уборка за занятый номер в сутки', kind: 'money', required: true },
      { key: 'staffCostAnnual', label: 'Персонал в год', kind: 'money', required: true },
      { key: 'licensesAnnual', label: 'Лицензии и разрешения в год', kind: 'money' },
    ],
  },
  area_rental: {
    code: 'area_rental',
    label: 'Аренда по площади',
    explain: 'Склады, офисы, производство: площадь × ставка за м² в месяц.',
    fields: [
      { key: 'lettableAreaM2', label: 'Площадь под аренду, м²', kind: 'number', required: true },
      { key: 'rentPerM2Month', label: 'Ставка за м² в месяц', kind: 'money', required: true },
    ],
  },
  land: {
    code: 'land',
    label: 'Доход с земли',
    explain: 'Только подтверждённый доход: аренда земли или собственный агродоход. Потенциал застройки в цифрах не считается.',
    fields: [
      { key: 'leaseIncomeAnnual', label: 'Аренда земли в год', kind: 'money' },
      { key: 'agriculturalIncomeAnnual', label: 'Сельхоздоход в год (чистый)', kind: 'money' },
    ],
  },
};
