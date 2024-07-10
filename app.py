import streamlit as st
from docx import Document
from io import BytesIO


# Функция для чтения содержимого PDF-файла
def read_pdf(file):
    try:
        # Открытие документа
        doc = Document(file)
        
        # Чтение текста из всех параграфов
        full_text = []
        for paragraph in doc.paragraphs:
            full_text.append(paragraph.text)
        
        # Возвращение текста как одной строки
        return '\n'.join(full_text)
    except Exception as e:
        return str(e)
st.title("Загрузка и чтение PDF-файла")

# Компонент для загрузки файла
uploaded_file = st.file_uploader("Загрузите PDF-файл", type=["pdf", "docx"])

if uploaded_file is not None:
    # Чтение содержимого PDF-файла
    pdf_text = read_pdf(uploaded_file)
    
    # Вывод содержимого в консоль
    print(pdf_text)
    
    # Отображение содержимого на веб-странице
    st.text_area("Содержимое PDF-файла", pdf_text)
