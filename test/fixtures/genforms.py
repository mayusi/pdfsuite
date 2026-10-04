from reportlab.pdfgen import canvas
from reportlab.lib.colors import blue
c = canvas.Canvas("form2.pdf", pagesize=(400, 400))
f = c.acroForm
c.drawString(20, 360, "Name:"); f.textfield(name="name", x=80, y=350, width=200, height=20)
c.drawString(20, 320, "Notes:"); f.textfield(name="notes", x=80, y=260, width=200, height=60, fieldFlags='multiline')
c.drawString(20, 230, "Agree:"); f.checkbox(name="agree", x=80, y=225, size=16)
c.drawString(20, 190, "Size:"); f.radio(name="size", value="S", x=80, y=185, size=14, selected=True); f.radio(name="size", value="L", x=110, y=185, size=14)
c.drawString(20, 150, "Color:"); f.choice(name="color", options=["Red", "Green", "Blue"], value="Red", x=80, y=140, width=120, height=20)
c.showPage(); c.save()
print('ok')
