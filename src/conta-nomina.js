// conta-nomina.js - cálculo de nómina dominicana (TSS e ISR de asalariados). Orientativo: las tasas, los topes y la escala
// se pueden cambiar en Contabilidad → Nómina → Parámetros; confírmalos cada año con la TSS y la DGII.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const PARAMS_NOMINA = {
  nom_afp_emp: 2.87, nom_sfs_emp: 3.04, nom_afp_pat: 7.10, nom_sfs_pat: 7.09, nom_srl_pat: 1.10, nom_infotep: 1.00,
  nom_tope_afp: 464460, nom_tope_sfs: 232230, nom_tope_srl: 92892, nom_isr_exento: 416220,
};
export const ETIQUETAS_NOMINA = {
  nom_afp_emp: 'AFP del empleado (%)', nom_sfs_emp: 'SFS del empleado (%)', nom_afp_pat: 'AFP del empleador (%)', nom_sfs_pat: 'SFS del empleador (%)',
  nom_srl_pat: 'Riesgos laborales del empleador (%)', nom_infotep: 'INFOTEP del empleador (%)', nom_tope_afp: 'Tope mensual AFP (RD$)',
  nom_tope_sfs: 'Tope mensual SFS (RD$)', nom_tope_srl: 'Tope mensual riesgos laborales (RD$)', nom_isr_exento: 'ISR: exención anual (RD$)',
};

export function paramsDesde(cfg) {
  const p = { ...PARAMS_NOMINA };
  for (const k of Object.keys(p)) { const v = parseFloat(cfg?.[k]); if (v >= 0) p[k] = v; }
  return p;
}

// Escala anual del ISR de asalariados (referencia: 416,220 / 624,329 / 867,123). Si se cambia la exención, la escala se ajusta en proporción.
export function isrAnual(base, exento = PARAMS_NOMINA.nom_isr_exento) {
  const f = exento / 416220;
  const L1 = 416220 * f, L2 = 624329 * f, L3 = 867123 * f;
  if (base <= L1) return 0;
  if (base <= L2) return (base - L1) * 0.15;
  if (base <= L3) return 31216 * f + (base - L2) * 0.20;
  return 79776 * f + (base - L3) * 0.25;
}

export function calcularNomina(emp, p, { otrosIngresos = 0, otrosDesc = 0 } = {}) {
  const base = r2((Number(emp.salario) || 0) + (Number(otrosIngresos) || 0));
  const con = (tasa, tope) => r2(Math.min(base, tope) * tasa / 100);
  const afp = con(p.nom_afp_emp, p.nom_tope_afp);
  const sfs = con(p.nom_sfs_emp, p.nom_tope_sfs);
  const isr = r2(isrAnual(Math.max(0, base - afp - sfs) * 12, p.nom_isr_exento) / 12);
  const desc = r2(Number(otrosDesc) || 0);
  return {
    salario: r2(Number(emp.salario) || 0), otros_ingresos: r2(Number(otrosIngresos) || 0), afp, sfs, isr, otros_desc: desc,
    neto: r2(base - afp - sfs - isr - desc),
    afp_pat: con(p.nom_afp_pat, p.nom_tope_afp), sfs_pat: con(p.nom_sfs_pat, p.nom_tope_sfs),
    srl_pat: con(p.nom_srl_pat, p.nom_tope_srl), infotep: r2(base * p.nom_infotep / 100),
  };
}
