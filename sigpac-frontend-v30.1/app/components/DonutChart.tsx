'use client'

import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'

interface Slice { value: number; color: string }

interface Props {
  slices: Slice[]
  innerRadius: number
  outerRadius: number
}

// Envoltorio fino sobre recharts, pensado para cargarse de forma diferida
// (dynamic import, ssr:false) y así no formar parte del paquete inicial que
// se descarga antes de que desaparezca la pantalla de carga de la PWA.
export default function DonutChart({ slices, innerRadius, outerRadius }: Props) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={slices} dataKey="value" innerRadius={innerRadius} outerRadius={outerRadius} startAngle={90} endAngle={-270} stroke="none">
          {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  )
}
